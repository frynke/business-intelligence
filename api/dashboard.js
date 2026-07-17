const {
  IFS_TOKEN_URL,
  IFS_CLIENT_ID,
  IFS_CLIENT_SECRET,
} = process.env;

const COMPANY_ID = "10";
const INTERNAL_CUSTOMER_ID = "INT";
const MODULE = "PRJREP";

const IFS_PROJECTION_BASE_URL =
  "https://ifsc-cfg.xeam.se/main/ifsapplications/projection/v1";

async function getAccessToken() {
  if (!IFS_TOKEN_URL || !IFS_CLIENT_ID || !IFS_CLIENT_SECRET) {
    throw new Error(
      "Missing environment variables: IFS_TOKEN_URL, IFS_CLIENT_ID or IFS_CLIENT_SECRET"
    );
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: IFS_CLIENT_ID,
    client_secret: IFS_CLIENT_SECRET,
  });

  const response = await fetch(IFS_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Token request failed: ${response.status} ${errorText}`
    );
  }

  const tokenData = await response.json();

  if (!tokenData.access_token) {
    throw new Error(
      "Token response did not contain access_token"
    );
  }

  return tokenData.access_token;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function createUtcDate(year, monthIndex, day) {
  return new Date(
    Date.UTC(year, monthIndex, day)
  );
}

function getMonday(date) {
  const result = new Date(date);
  const weekday = result.getUTCDay();

  const daysSinceMonday =
    weekday === 0 ? 6 : weekday - 1;

  result.setUTCDate(
    result.getUTCDate() - daysSinceMonday
  );

  result.setUTCHours(0, 0, 0, 0);

  return result;
}

function addDays(date, numberOfDays) {
  const result = new Date(date);

  result.setUTCDate(
    result.getUTCDate() + numberOfDays
  );

  return result;
}

function getSunday(monday) {
  return addDays(monday, 6);
}

function isDateWithinRange(date, from, to) {
  return date >= from && date <= to;
}

function getPeriodRange(
  period,
  now = new Date()
) {
  if (period === "this-week") {
    const from = getMonday(now);
    const to = getSunday(from);

    return {
      type: period,
      from,
      to,
    };
  }

  if (period === "this-month") {
    const year = now.getUTCFullYear();
    const monthIndex = now.getUTCMonth();

    return {
      type: period,

      from: createUtcDate(
        year,
        monthIndex,
        1
      ),

      to: createUtcDate(
        year,
        monthIndex + 1,
        0
      ),
    };
  }

  throw new Error(
    `Unsupported period: ${period}`
  );
}

function getRequiredMondays(from, to) {
  const mondays = [];

  let currentMonday = getMonday(from);

  while (currentMonday <= to) {
    mondays.push(
      new Date(currentMonday)
    );

    currentMonday = addDays(
      currentMonday,
      7
    );
  }

  return mondays;
}

async function fetchFromIFS(
  url,
  accessToken,
  description
) {
  console.log(`${description} URL:`, url);

  const response = await fetch(url, {
    method: "GET",

    headers: {
      Authorization:
        `Bearer ${accessToken}`,

      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `${description} failed: ` +
      `${response.status} ${errorText}`
    );
  }

  const data = await response.json();

  return Array.isArray(data.value)
    ? data.value
    : [];
}

function buildTimeUrl(monday) {
  const year =
    monday.getUTCFullYear();

  const month =
    monday.getUTCMonth() + 1;

  const day =
    monday.getUTCDate();

  return (
    `${IFS_PROJECTION_BASE_URL}/` +
    "TimeRegistrationEmployeeHandling.svc/" +
    "TimmanJobTranses" +
    `?$filter=Module eq '${MODULE}'` +
    ` and CompanyId eq '${COMPANY_ID}'` +
    ` and year(AccountDate) eq ${year}` +
    ` and month(AccountDate) eq ${month}` +
    ` and day(AccountDate) eq ${day}`
  );
}

function buildProjectsUrl() {
  return (
    `${IFS_PROJECTION_BASE_URL}/` +
    "ProjectDefinitionHandling.svc/" +
    "Projects" +
    "?$select=ProjectId,CustomerId"
  );
}

function buildCustomersUrl() {
  return (
    `${IFS_PROJECTION_BASE_URL}/` +
    "CustomerHandling.svc/" +
    "CustomerInfoSet" +
    "?$select=CustomerId,Name"
  );
}

async function fetchDashboardSourceData(
  mondays
) {
  const accessToken =
    await getAccessToken();

  const timeRequests =
    mondays.map((monday) =>
      fetchFromIFS(
        buildTimeUrl(monday),
        accessToken,
        `IFS time request for week ${formatDate(
          monday
        )}`
      ).then((rows) => ({
        monday,
        rows,
      }))
    );

  const [
    weeks,
    projects,
    customers,
  ] = await Promise.all([
    Promise.all(timeRequests),

    fetchFromIFS(
      buildProjectsUrl(),
      accessToken,
      "IFS project request"
    ),

    fetchFromIFS(
      buildCustomersUrl(),
      accessToken,
      "IFS customer request"
    ),
  ]);

  return {
    weeks,
    projects,
    customers,
  };
}

function getProjectId(
  activityShortName
) {
  if (
    !activityShortName ||
    typeof activityShortName !== "string"
  ) {
    return "Unknown";
  }

  return (
    activityShortName.split(".")[0] ||
    "Unknown"
  );
}

function convertWeekRowsToDailyEntries(
  rows,
  monday,
  periodFrom,
  periodTo
) {
  const entries = [];

  for (const row of rows) {
    for (
      let dayNumber = 1;
      dayNumber <= 7;
      dayNumber += 1
    ) {
      const entryDate = addDays(
        monday,
        dayNumber - 1
      );

      if (
        !isDateWithinRange(
          entryDate,
          periodFrom,
          periodTo
        )
      ) {
        continue;
      }

      const hoursField =
        `HoursDay${dayNumber}`;

      const transactionCountField =
        `NumberOfTransDay${dayNumber}`;

      const objidField =
        `ObjidDay${dayNumber}`;

      const objversionField =
        `ObjversionDay${dayNumber}`;

      const hours = Number(
        row[hoursField] ?? 0
      );

      if (hours <= 0) {
        continue;
      }

      const activityShortName =
        row.Col1 || null;

      entries.push({
        id:
          row[objidField] ||
          [
            row.CompanyId,
            row.EmpNo,
            row.ModuleRowNo,
            formatDate(entryDate),
          ].join("-"),

        date: formatDate(entryDate),

        companyId:
          row.CompanyId
            ? String(row.CompanyId)
            : null,

        employeeId:
          row.EmpNo
            ? String(row.EmpNo)
            : null,

        module: row.Module,

        moduleRowNo:
          row.ModuleRowNo,

        projectId:
          getProjectId(
            activityShortName
          ),

        activityShortName,

        activityDescription:
          row.Col1Desc || null,

        activityLabel:
          row.ReferenceLabel || null,

        reportingCode:
          row.Col2 || "Unknown",

        reportingCodeDescription:
          row.JobDetailLabel ||
          row.Col2 ||
          "Unknown",

        organizationCode:
          row.OrgCode ||
          row.Col3 ||
          null,

        hours,

        numberOfTransactions:
          Number(
            row[
              transactionCountField
            ] ?? 0
          ),

        objid:
          row[objidField] || null,

        objversion:
          row[objversionField] || null,
      });
    }
  }

  return entries;
}

function convertWeeksToDailyEntries(
  weeks,
  periodFrom,
  periodTo
) {
  return weeks.flatMap(
    ({ monday, rows }) =>
      convertWeekRowsToDailyEntries(
        rows,
        monday,
        periodFrom,
        periodTo
      )
  );
}

function buildMasterDataMaps(
  projects,
  customers
) {
  const customerById = new Map();

  for (const customer of customers) {
    if (!customer.CustomerId) {
      continue;
    }

    const customerId = String(
      customer.CustomerId
    );

    customerById.set(customerId, {
      customerId,

      customerName:
        customer.Name ||
        `Customer ${customerId}`,
    });
  }

  const projectById = new Map();

  for (const project of projects) {
    if (!project.ProjectId) {
      continue;
    }

    const projectId = String(
      project.ProjectId
    );

    const customerId =
      project.CustomerId
        ? String(project.CustomerId)
        : null;

    const customer =
      customerId
        ? customerById.get(customerId)
        : null;

    projectById.set(projectId, {
      projectId,
      customerId,

      customerName:
        customer?.customerName ||
        null,
    });
  }

  return {
    projectById,
  };
}

function enrichEntriesWithCustomers(
  entries,
  projects,
  customers
) {
  const { projectById } =
    buildMasterDataMaps(
      projects,
      customers
    );

  return entries.map((entry) => {
    const project =
      projectById.get(
        entry.projectId
      );

    if (!project) {
      return {
        ...entry,

        customerId: null,

        customerName:
          "Unknown customer",

        customerType:
          "unknown",

        customerMappingStatus:
          "project-not-found",
      };
    }

    if (!project.customerId) {
      return {
        ...entry,

        customerId: null,

        customerName:
          "Unknown customer",

        customerType:
          "unknown",

        customerMappingStatus:
          "project-has-no-customer",
      };
    }

    const isInternal =
      project.customerId
        .trim()
        .toUpperCase() ===
      INTERNAL_CUSTOMER_ID;

    if (isInternal) {
      return {
        ...entry,

        customerId:
          project.customerId,

        customerName:
          project.customerName ||
          "Internal",

        customerType:
          "internal",

        customerMappingStatus:
          "internal-customer",
      };
    }

    if (!project.customerName) {
      return {
        ...entry,

        customerId:
          project.customerId,

        customerName:
          "Unknown customer",

        customerType:
          "unknown",

        customerMappingStatus:
          "customer-not-found",
      };
    }

    return {
      ...entry,

      customerId:
        project.customerId,

      customerName:
        project.customerName,

      customerType:
        "customer",

      customerMappingStatus:
        "mapped",
    };
  });
}

function aggregateDailyHours(
  entries,
  periodFrom,
  periodTo
) {
  const totalsByDate = new Map();

  let currentDate =
    new Date(periodFrom);

  while (currentDate <= periodTo) {
    totalsByDate.set(
      formatDate(currentDate),
      0
    );

    currentDate = addDays(
      currentDate,
      1
    );
  }

  for (const entry of entries) {
    totalsByDate.set(
      entry.date,

      (
        totalsByDate.get(
          entry.date
        ) || 0
      ) + entry.hours
    );
  }

  return Array.from(
    totalsByDate.entries()
  ).map(([date, hours]) => ({
    date,
    hours,
  }));
}

function aggregateByReportingCode(
  entries,
  totalHours
) {
  const groups = new Map();

  for (const entry of entries) {
    const key =
      entry.reportingCode;

    if (!groups.has(key)) {
      groups.set(key, {
        code:
          entry.reportingCode,

        description:
          entry
            .reportingCodeDescription,

        hours: 0,
      });
    }

    groups.get(key).hours +=
      entry.hours;
  }

  return Array.from(
    groups.values()
  )
    .map((group) => ({
      ...group,

      percentage:
        totalHours > 0
          ? Number(
              (
                (
                  group.hours /
                  totalHours
                ) * 100
              ).toFixed(1)
            )
          : 0,
    }))
    .sort(
      (a, b) =>
        b.hours - a.hours
    );
}

function aggregateByProject(
  entries,
  totalHours
) {
  const groups = new Map();

  for (const entry of entries) {
    const key =
      entry.projectId;

    if (!groups.has(key)) {
      groups.set(key, {
        projectId:
          entry.projectId,

        projectLabel:
          entry.activityLabel,

        customerId:
          entry.customerId,

        customerName:
          entry.customerName,

        customerType:
          entry.customerType,

        hours: 0,
      });
    }

    groups.get(key).hours +=
      entry.hours;
  }

  return Array.from(
    groups.values()
  )
    .map((group) => ({
      ...group,

      percentage:
        totalHours > 0
          ? Number(
              (
                (
                  group.hours /
                  totalHours
                ) * 100
              ).toFixed(1)
            )
          : 0,
    }))
    .sort(
      (a, b) =>
        b.hours - a.hours
    );
}

function aggregateByCustomer(
  entries,
  customerHours
) {
  const groups = new Map();

  for (const entry of entries) {
    if (
      entry.customerType !==
      "customer"
    ) {
      continue;
    }

    const key =
      entry.customerId;

    if (!groups.has(key)) {
      groups.set(key, {
        customerId:
          entry.customerId,

        customerName:
          entry.customerName,

        hours: 0,
      });
    }

    groups.get(key).hours +=
      entry.hours;
  }

  return Array.from(
    groups.values()
  )
    .map((group) => ({
      ...group,

      percentage:
        customerHours > 0
          ? Number(
              (
                (
                  group.hours /
                  customerHours
                ) * 100
              ).toFixed(1)
            )
          : 0,
    }))
    .sort(
      (a, b) =>
        b.hours - a.hours
    );
}

function calculateUtilization(
  entries
) {
  let customerHours = 0;
  let internalHours = 0;
  let unknownHours = 0;

  for (const entry of entries) {
    if (
      entry.customerType ===
      "customer"
    ) {
      customerHours +=
        entry.hours;
    } else if (
      entry.customerType ===
      "internal"
    ) {
      internalHours +=
        entry.hours;
    } else {
      unknownHours +=
        entry.hours;
    }
  }

  const classifiedHours =
    customerHours +
    internalHours;

  const customerUtilization =
    classifiedHours > 0
      ? Number(
          (
            (
              customerHours /
              classifiedHours
            ) * 100
          ).toFixed(1)
        )
      : 0;

  return {
    customerHours,
    internalHours,
    unknownHours,
    classifiedHours,
    customerUtilization,
  };
}

function calculateCustomerConcentration(
  hoursByCustomer
) {
  const customerHours =
    hoursByCustomer.reduce(
      (total, customer) =>
        total + customer.hours,
      0
    );

  const sumTopCustomers =
    (count) =>
      hoursByCustomer
        .slice(0, count)
        .reduce(
          (total, customer) =>
            total +
            customer.hours,
          0
        );

  const toPercentage =
    (hours) =>
      customerHours > 0
        ? Number(
            (
              (
                hours /
                customerHours
              ) * 100
            ).toFixed(1)
          )
        : 0;

  const largestCustomer =
    hoursByCustomer[0] ||
    null;

  const top3Hours =
    sumTopCustomers(3);

  const top5Hours =
    sumTopCustomers(5);

  return {
    largestCustomerId:
      largestCustomer
        ?.customerId || null,

    largestCustomerName:
      largestCustomer
        ?.customerName || null,

    largestCustomerHours:
      largestCustomer
        ?.hours || 0,

    largestCustomerPercentage:
      largestCustomer
        ?.percentage || 0,

    top3Hours,

    top3Percentage:
      toPercentage(top3Hours),

    top5Hours,

    top5Percentage:
      toPercentage(top5Hours),

    customerCount:
      hoursByCustomer.length,
  };
}

function buildCustomerMappingDiagnostics(
  entries
) {
  const mappingIssues =
    new Map();

  const validStatuses =
    new Set([
      "mapped",
      "internal-customer",
    ]);

  for (const entry of entries) {
    if (
      validStatuses.has(
        entry.customerMappingStatus
      )
    ) {
      continue;
    }

    const key =
      [
        entry.projectId,
        entry.customerMappingStatus,
      ].join("-");

    if (
      !mappingIssues.has(key)
    ) {
      mappingIssues.set(key, {
        projectId:
          entry.projectId,

        status:
          entry
            .customerMappingStatus,

        hours: 0,
      });
    }

    mappingIssues.get(key).hours +=
      entry.hours;
  }

  return Array.from(
    mappingIssues.values()
  ).sort(
    (a, b) =>
      b.hours - a.hours
  );
}

function buildExecutiveBrief(
  period,
  summary
) {
  const title =
    period.type === "this-week"
      ? "This week"
      : "This month";

  const customerWord =
    summary
      .customersWithReportedHours === 1
      ? "customer"
      : "customers";

  const projectWord =
    summary
      .projectsWithReportedHours === 1
      ? "project"
      : "projects";

  return {
    title,

    lines: [
      `${summary.totalHours} reported hours`,

      `across ${summary.customersWithReportedHours} ${customerWord}`,

      `on ${summary.projectsWithReportedHours} ${projectWord}`,

      `with ${summary.customerUtilization}% customer utilization`,
    ],

    text:
      `${summary.totalHours} reported hours ` +
      `across ${summary.customersWithReportedHours} ${customerWord} ` +
      `on ${summary.projectsWithReportedHours} ${projectWord} ` +
      `with ${summary.customerUtilization}% customer utilization.`,
  };
}

export default async function handler(
  req,
  res
) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );

  if (req.method === "OPTIONS") {
    return res
      .status(200)
      .end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      error:
        "Method not allowed",

      allowedMethods: [
        "GET",
      ],
    });
  }

  try {
    const period =
      req.query.period ||
      "this-week";

    if (
      period !== "this-week" &&
      period !== "this-month"
    ) {
      return res
        .status(400)
        .json({
          error:
            "Unsupported period",

          supportedPeriods: [
            "this-week",
            "this-month",
          ],
        });
    }

    const periodRange =
      getPeriodRange(period);

    const mondays =
      getRequiredMondays(
        periodRange.from,
        periodRange.to
      );

    const {
      weeks,
      projects,
      customers,
    } =
      await fetchDashboardSourceData(
        mondays
      );

    const rawDailyEntries =
      convertWeeksToDailyEntries(
        weeks,
        periodRange.from,
        periodRange.to
      );

    const dailyEntries =
      enrichEntriesWithCustomers(
        rawDailyEntries,
        projects,
        customers
      );

    const totalHours =
      dailyEntries.reduce(
        (total, entry) =>
          total + entry.hours,
        0
      );

    const utilization =
      calculateUtilization(
        dailyEntries
      );

    const dailyHours =
      aggregateDailyHours(
        dailyEntries,
        periodRange.from,
        periodRange.to
      );

    const hoursByReportingCode =
      aggregateByReportingCode(
        dailyEntries,
        totalHours
      );

    const hoursByProject =
      aggregateByProject(
        dailyEntries,
        totalHours
      );

    const hoursByCustomer =
      aggregateByCustomer(
        dailyEntries,
        utilization.customerHours
      );

    const customerConcentration =
      calculateCustomerConcentration(
        hoursByCustomer
      );

    const customerMappingIssues =
      buildCustomerMappingDiagnostics(
        dailyEntries
      );

    const employeeIds = [
      ...new Set(
        dailyEntries
          .map(
            (entry) =>
              entry.employeeId
          )
          .filter(Boolean)
      ),
    ].sort();

    const rawTimeRowCount =
      weeks.reduce(
        (total, week) =>
          total +
          week.rows.length,
        0
      );

    const periodResponse = {
      type:
        periodRange.type,

      from:
        formatDate(
          periodRange.from
        ),

      to:
        formatDate(
          periodRange.to
        ),
    };

    const summary = {
      totalHours,

      customerHours:
        utilization.customerHours,

      internalHours:
        utilization.internalHours,

      unknownHours:
        utilization.unknownHours,

      classifiedHours:
        utilization.classifiedHours,

      customerUtilization:
        utilization
          .customerUtilization,

      numberOfTimeEntries:
        dailyEntries.length,

      employeesWithReportedHours:
        employeeIds.length,

      projectsWithReportedHours:
        hoursByProject.length,

      reportingCodesUsed:
        hoursByReportingCode.length,

      customersWithReportedHours:
        hoursByCustomer.length,

      entriesWithCustomerMapping:
        dailyEntries.filter(
          (entry) =>
            entry
              .customerMappingStatus ===
              "mapped" ||
            entry
              .customerMappingStatus ===
              "internal-customer"
        ).length,

      entriesWithoutCustomerMapping:
        dailyEntries.filter(
          (entry) =>
            entry.customerType ===
            "unknown"
        ).length,
    };

    const executiveBrief =
      buildExecutiveBrief(
        periodResponse,
        summary
      );

    return res.status(200).json({
      version:
        "time-intelligence-api-v8",

      period:
        periodResponse,

      executiveBrief,

      filters: {
        employeeCompanyId:
          COMPANY_ID,

        internalCustomerId:
          INTERNAL_CUSTOMER_ID,

        module:
          MODULE,
      },

      summary,

      dailyHours,

      hoursByCustomer,

      hoursByReportingCode,

      hoursByProject,

      customerConcentration,

      diagnostics: {
        requestedWeekCount:
          mondays.length,

        requestedWeeks:
          mondays.map(
            formatDate
          ),

        rawTimeRowCount,

        employeeCount:
          employeeIds.length,

        employeeIds,

        projectMasterDataCount:
          projects.length,

        customerMasterDataCount:
          customers.length,

        customerMappingIssues,
      },

      dailyEntries,
    });
  } catch (error) {
    console.error(
      "GET /api/dashboard failed:",
      error
    );

    return res.status(500).json({
      version:
        "time-intelligence-api-v8",

      error:
        "Failed to generate dashboard data",

      details:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}
