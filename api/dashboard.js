const {
  IFS_TOKEN_URL,
  IFS_CLIENT_ID,
  IFS_CLIENT_SECRET,
} = process.env;

const COMPANY_ID = "10";
const EMP_NO = "1045";
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
    throw new Error("Token response did not contain access_token");
  }

  return tokenData.access_token;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function getMonday(date) {
  const result = new Date(date);
  const weekday = result.getUTCDay();

  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;

  result.setUTCDate(result.getUTCDate() - daysSinceMonday);
  result.setUTCHours(0, 0, 0, 0);

  return result;
}

function getSunday(monday) {
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);

  return sunday;
}

function addDays(date, numberOfDays) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + numberOfDays);

  return result;
}

async function fetchFromIFS(url, accessToken, description) {
  console.log(`${description} URL:`, url);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `${description} failed: ${response.status} ${errorText}`
    );
  }

  const data = await response.json();

  return Array.isArray(data.value) ? data.value : [];
}

function buildTimeUrl(monday) {
  const year = monday.getUTCFullYear();
  const month = monday.getUTCMonth() + 1;
  const day = monday.getUTCDate();

  return (
    `${IFS_PROJECTION_BASE_URL}/` +
    "TimeRegistrationEmployeeHandling.svc/TimmanJobTranses" +
    `?$filter=Module eq '${MODULE}'` +
    ` and EmpNo eq '${EMP_NO}'` +
    ` and CompanyId eq '${COMPANY_ID}'` +
    ` and year(AccountDate) eq ${year}` +
    ` and month(AccountDate) eq ${month}` +
    ` and day(AccountDate) eq ${day}`
  );
}

function buildProjectsUrl() {
  return (
    `${IFS_PROJECTION_BASE_URL}/` +
    "ProjectDefinitionHandling.svc/Projects" +
    "?$select=ProjectId,CustomerId"
  );
}

function buildCustomersUrl() {
  return (
    `${IFS_PROJECTION_BASE_URL}/` +
    "CustomerHandling.svc/CustomerInfoSet" +
    "?$select=CustomerId,Name"
  );
}

async function fetchDashboardSourceData(monday) {
  const accessToken = await getAccessToken();

  const [timeRows, projects, customers] = await Promise.all([
    fetchFromIFS(
      buildTimeUrl(monday),
      accessToken,
      "IFS dashboard time request"
    ),
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
    timeRows,
    projects,
    customers,
  };
}

function getProjectId(activityShortName) {
  if (
    !activityShortName ||
    typeof activityShortName !== "string"
  ) {
    return "Unknown";
  }

  return activityShortName.split(".")[0] || "Unknown";
}

function convertRowsToDailyEntries(rows, monday) {
  const entries = [];

  for (const row of rows) {
    for (let dayNumber = 1; dayNumber <= 7; dayNumber += 1) {
      const hoursField = `HoursDay${dayNumber}`;
      const transactionCountField =
        `NumberOfTransDay${dayNumber}`;
      const objidField = `ObjidDay${dayNumber}`;
      const objversionField = `ObjversionDay${dayNumber}`;

      const hours = Number(row[hoursField] ?? 0);

      if (hours <= 0) {
        continue;
      }

      const entryDate = addDays(monday, dayNumber - 1);
      const activityShortName = row.Col1 || null;

      entries.push({
        id:
          row[objidField] ||
          `${row.CompanyId}-${row.EmpNo}-${row.ModuleRowNo}-${dayNumber}`,

        date: formatDate(entryDate),

        companyId: row.CompanyId,
        employeeId: row.EmpNo,
        module: row.Module,
        moduleRowNo: row.ModuleRowNo,

        projectId: getProjectId(activityShortName),

        activityShortName,
        activityDescription: row.Col1Desc || null,
        activityLabel: row.ReferenceLabel || null,

        reportingCode: row.Col2 || "Unknown",
        reportingCodeDescription:
          row.JobDetailLabel || row.Col2 || "Unknown",

        organizationCode: row.OrgCode || row.Col3 || null,

        hours,

        numberOfTransactions: Number(
          row[transactionCountField] ?? 0
        ),

        objid: row[objidField] || null,
        objversion: row[objversionField] || null,
      });
    }
  }

  return entries;
}

function buildMasterDataMaps(projects, customers) {
  const customerById = new Map();

  for (const customer of customers) {
    if (!customer.CustomerId) {
      continue;
    }

    customerById.set(String(customer.CustomerId), {
      customerId: String(customer.CustomerId),
      customerName:
        customer.Name || `Customer ${customer.CustomerId}`,
    });
  }

  const projectById = new Map();

  for (const project of projects) {
    if (!project.ProjectId) {
      continue;
    }

    const customerId = project.CustomerId
      ? String(project.CustomerId)
      : null;

    const customer = customerId
      ? customerById.get(customerId)
      : null;

    projectById.set(String(project.ProjectId), {
      projectId: String(project.ProjectId),
      customerId,
      customerName: customer?.customerName || null,
    });
  }

  return {
    projectById,
    customerById,
  };
}

function enrichEntriesWithCustomers(
  entries,
  projects,
  customers
) {
  const { projectById } = buildMasterDataMaps(
    projects,
    customers
  );

  return entries.map((entry) => {
    const project = projectById.get(entry.projectId);

    if (!project) {
      return {
        ...entry,
        customerId: null,
        customerName: "Unknown customer",
        customerType: "unknown",
        customerMappingStatus: "project-not-found",
      };
    }

    if (!project.customerId) {
      return {
        ...entry,
        customerId: null,
        customerName: "Internal / no customer",
        customerType: "internal",
        customerMappingStatus: "project-has-no-customer",
      };
    }

    if (!project.customerName) {
      return {
        ...entry,
        customerId: project.customerId,
        customerName: "Unknown customer",
        customerType: "unknown",
        customerMappingStatus: "customer-not-found",
      };
    }

    return {
      ...entry,
      customerId: project.customerId,
      customerName: project.customerName,
      customerType: "customer",
      customerMappingStatus: "mapped",
    };
  });
}

function aggregateDailyHours(entries, monday) {
  const totalsByDate = new Map();

  for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
    const date = formatDate(addDays(monday, dayOffset));
    totalsByDate.set(date, 0);
  }

  for (const entry of entries) {
    totalsByDate.set(
      entry.date,
      (totalsByDate.get(entry.date) || 0) + entry.hours
    );
  }

  return Array.from(totalsByDate.entries()).map(
    ([date, hours]) => ({
      date,
      hours,
    })
  );
}

function aggregateByReportingCode(entries, totalHours) {
  const groups = new Map();

  for (const entry of entries) {
    const key = entry.reportingCode;

    if (!groups.has(key)) {
      groups.set(key, {
        code: entry.reportingCode,
        description: entry.reportingCodeDescription,
        hours: 0,
      });
    }

    groups.get(key).hours += entry.hours;
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      percentage:
        totalHours > 0
          ? Number(
              ((group.hours / totalHours) * 100).toFixed(1)
            )
          : 0,
    }))
    .sort((a, b) => b.hours - a.hours);
}

function aggregateByProject(entries, totalHours) {
  const groups = new Map();

  for (const entry of entries) {
    const key = entry.projectId;

    if (!groups.has(key)) {
      groups.set(key, {
        projectId: entry.projectId,
        projectLabel: entry.activityLabel,
        customerId: entry.customerId,
        customerName: entry.customerName,
        customerType: entry.customerType,
        hours: 0,
      });
    }

    groups.get(key).hours += entry.hours;
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      percentage:
        totalHours > 0
          ? Number(
              ((group.hours / totalHours) * 100).toFixed(1)
            )
          : 0,
    }))
    .sort((a, b) => b.hours - a.hours);
}

/**
 * KPI 1: Hours by customer.
 *
 * Only entries mapped to an actual customer are included here.
 * Internal and unknown entries are handled separately.
 */
function aggregateByCustomer(entries, customerHours) {
  const groups = new Map();

  for (const entry of entries) {
    if (entry.customerType !== "customer") {
      continue;
    }

    const key = entry.customerId;

    if (!groups.has(key)) {
      groups.set(key, {
        customerId: entry.customerId,
        customerName: entry.customerName,
        hours: 0,
      });
    }

    groups.get(key).hours += entry.hours;
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      percentage:
        customerHours > 0
          ? Number(
              ((group.hours / customerHours) * 100).toFixed(1)
            )
          : 0,
    }))
    .sort((a, b) => b.hours - a.hours);
}

/**
 * KPI 3: Customer utilization.
 *
 * Unknown hours are excluded from the utilization denominator because
 * they cannot yet be reliably classified as customer or internal.
 */
function calculateUtilization(entries) {
  let customerHours = 0;
  let internalHours = 0;
  let unknownHours = 0;

  for (const entry of entries) {
    if (entry.customerType === "customer") {
      customerHours += entry.hours;
    } else if (entry.customerType === "internal") {
      internalHours += entry.hours;
    } else {
      unknownHours += entry.hours;
    }
  }

  const classifiedHours = customerHours + internalHours;

  const customerUtilization =
    classifiedHours > 0
      ? Number(
          ((customerHours / classifiedHours) * 100).toFixed(1)
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

/**
 * KPI 6: Customer concentration.
 *
 * Percentages are calculated against total customer hours,
 * not total reported hours.
 */
function calculateCustomerConcentration(hoursByCustomer) {
  const customerHours = hoursByCustomer.reduce(
    (total, customer) => total + customer.hours,
    0
  );

  const sumTopCustomers = (count) =>
    hoursByCustomer
      .slice(0, count)
      .reduce(
        (total, customer) => total + customer.hours,
        0
      );

  const toPercentage = (hours) =>
    customerHours > 0
      ? Number(((hours / customerHours) * 100).toFixed(1))
      : 0;

  const largestCustomer = hoursByCustomer[0] || null;

  return {
    largestCustomerId: largestCustomer?.customerId || null,
    largestCustomerName:
      largestCustomer?.customerName || null,
    largestCustomerHours: largestCustomer?.hours || 0,
    largestCustomerPercentage:
      largestCustomer?.percentage || 0,

    top3Hours: sumTopCustomers(3),
    top3Percentage: toPercentage(sumTopCustomers(3)),

    top5Hours: sumTopCustomers(5),
    top5Percentage: toPercentage(sumTopCustomers(5)),

    customerCount: hoursByCustomer.length,
  };
}

function buildCustomerMappingDiagnostics(entries) {
  const unmappedProjects = new Map();

  for (const entry of entries) {
    if (entry.customerMappingStatus === "mapped") {
      continue;
    }

    const key = `${entry.projectId}-${entry.customerMappingStatus}`;

    if (!unmappedProjects.has(key)) {
      unmappedProjects.set(key, {
        projectId: entry.projectId,
        status: entry.customerMappingStatus,
        hours: 0,
      });
    }

    unmappedProjects.get(key).hours += entry.hours;
  }

  return Array.from(unmappedProjects.values()).sort(
    (a, b) => b.hours - a.hours
  );
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
      allowedMethods: ["GET"],
    });
  }

  try {
    const period = req.query.period || "this-week";

    if (period !== "this-week") {
      return res.status(400).json({
        error: "Unsupported period",
        supportedPeriods: ["this-week"],
      });
    }

    const now = new Date();
    const monday = getMonday(now);
    const sunday = getSunday(monday);

    const {
      timeRows,
      projects,
      customers,
    } = await fetchDashboardSourceData(monday);

    const rawDailyEntries = convertRowsToDailyEntries(
      timeRows,
      monday
    );

    const dailyEntries = enrichEntriesWithCustomers(
      rawDailyEntries,
      projects,
      customers
    );

    const totalHours = dailyEntries.reduce(
      (total, entry) => total + entry.hours,
      0
    );

    const utilization =
      calculateUtilization(dailyEntries);

    const dailyHours = aggregateDailyHours(
      dailyEntries,
      monday
    );

    const hoursByReportingCode =
      aggregateByReportingCode(
        dailyEntries,
        totalHours
      );

    const hoursByProject = aggregateByProject(
      dailyEntries,
      totalHours
    );

    const hoursByCustomer = aggregateByCustomer(
      dailyEntries,
      utilization.customerHours
    );

    const customerConcentration =
      calculateCustomerConcentration(
        hoursByCustomer
      );

    const customerMappingIssues =
      buildCustomerMappingDiagnostics(dailyEntries);

    const mappedEntries = dailyEntries.filter(
      (entry) =>
        entry.customerMappingStatus === "mapped"
    );

    return res.status(200).json({
      version: "time-intelligence-api-v5",

      period: {
        type: "this-week",
        from: formatDate(monday),
        to: formatDate(sunday),
      },

      filters: {
        companyId: COMPANY_ID,
        employeeId: EMP_NO,
        module: MODULE,
      },

      summary: {
        totalHours,

        customerHours: utilization.customerHours,
        internalHours: utilization.internalHours,
        unknownHours: utilization.unknownHours,
        classifiedHours: utilization.classifiedHours,

        customerUtilization:
          utilization.customerUtilization,

        numberOfTimeEntries: dailyEntries.length,
        projectsWithReportedHours: hoursByProject.length,
        reportingCodesUsed: hoursByReportingCode.length,
        customersWithReportedHours:
          hoursByCustomer.length,

        entriesWithCustomerMapping:
          mappedEntries.length,

        entriesWithoutCustomerMapping:
          dailyEntries.length - mappedEntries.length,
      },

      dailyHours,
      hoursByCustomer,
      hoursByReportingCode,
      hoursByProject,
      customerConcentration,

      diagnostics: {
        rawTimeRowCount: timeRows.length,
        projectMasterDataCount: projects.length,
        customerMasterDataCount: customers.length,
        customerMappingIssues,
      },

      dailyEntries,
    });
  } catch (error) {
    console.error("GET /api/dashboard failed:", error);

    return res.status(500).json({
      version: "time-intelligence-api-v5",
      error: "Failed to generate dashboard data",
      details:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}
