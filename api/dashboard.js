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

/**
 * Get an OAuth token from IFS.
 */
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

/**
 * Format a UTC Date as YYYY-MM-DD.
 */
function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Return Monday for the week containing the supplied date.
 */
function getMonday(date) {
  const result = new Date(date);
  const weekday = result.getUTCDay();

  // Sunday = 0, Monday = 1, ..., Saturday = 6
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;

  result.setUTCDate(result.getUTCDate() - daysSinceMonday);
  result.setUTCHours(0, 0, 0, 0);

  return result;
}

/**
 * Return Sunday for the week beginning on the supplied Monday.
 */
function getSunday(monday) {
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);

  return sunday;
}

/**
 * Add days to a UTC date.
 */
function addDays(date, numberOfDays) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + numberOfDays);

  return result;
}

/**
 * Build the IFS URL for one weekly time-registration record set.
 */
function buildIfsUrl(monday) {
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

/**
 * Fetch one complete week from IFS.
 */
async function fetchWeekFromIFS(monday) {
  const accessToken = await getAccessToken();
  const ifsUrl = buildIfsUrl(monday);

  console.log("IFS dashboard week URL:", ifsUrl);

  const response = await fetch(ifsUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `IFS dashboard request failed: ${response.status} ${errorText}`
    );
  }

  const data = await response.json();

  return Array.isArray(data.value) ? data.value : [];
}

/**
 * Extract the project ID from an activity short name.
 *
 * Example:
 * AFR-001.90.100 -> AFR-001
 */
function getProjectId(activityShortName) {
  if (
    !activityShortName ||
    typeof activityShortName !== "string"
  ) {
    return "Unknown";
  }

  return activityShortName.split(".")[0] || "Unknown";
}

/**
 * Convert weekly IFS rows into individual daily entries.
 */
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

/**
 * Aggregate total hours by date.
 */
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

/**
 * Aggregate hours by reporting code.
 */
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

/**
 * Aggregate hours by project.
 */
function aggregateByProject(entries, totalHours) {
  const groups = new Map();

  for (const entry of entries) {
    const key = entry.projectId;

    if (!groups.has(key)) {
      groups.set(key, {
        projectId: entry.projectId,
        projectLabel: entry.activityLabel,
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

    const rows = await fetchWeekFromIFS(monday);
    const dailyEntries = convertRowsToDailyEntries(
      rows,
      monday
    );

    const totalHours = dailyEntries.reduce(
      (total, entry) => total + entry.hours,
      0
    );

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

    return res.status(200).json({
      version: "time-intelligence-api-v3",

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
        numberOfTimeEntries: dailyEntries.length,
        projectsWithReportedHours: hoursByProject.length,
        reportingCodesUsed:
          hoursByReportingCode.length,
      },

      dailyHours,
      hoursByReportingCode,
      hoursByProject,

      diagnostics: {
        rawRowCount: rows.length,
      },

      dailyEntries,
    });
  } catch (error) {
    console.error("GET /api/dashboard failed:", error);

    return res.status(500).json({
      version: "time-intelligence-api-v3",
      error: "Failed to generate dashboard data",
      details:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}
