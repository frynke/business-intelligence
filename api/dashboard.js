const {
  IFS_TOKEN_URL,
  IFS_CLIENT_ID,
  IFS_CLIENT_SECRET,
} = process.env;

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

async function fetchTestWeekFromIFS() {
  const accessToken = await getAccessToken();

  const ifsUrl =
    "https://ifsc-cfg.xeam.se/main/ifsapplications/projection/v1/" +
    "TimeRegistrationEmployeeHandling.svc/TimmanJobTranses" +
    "?$filter=Module eq 'PRJREP'" +
    " and EmpNo eq '1045'" +
    " and CompanyId eq '10'" +
    " and year(AccountDate) eq 2026" +
    " and month(AccountDate) eq 7" +
    " and day(AccountDate) eq 27";

  console.log("IFS dashboard test URL:", ifsUrl);

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
      `IFS dashboard test failed: ${response.status} ${errorText}`
    );
  }

  const data = await response.json();

  return Array.isArray(data.value) ? data.value : [];
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const rows = await fetchTestWeekFromIFS();

    return res.status(200).json({
      version: "time-intelligence-api-v2",
      ifsConnected: true,
      rawRowCount: rows.length,
      sample: rows.slice(0, 2).map((row) => ({
        companyId: row.CompanyId,
        employeeId: row.EmpNo,
        module: row.Module,
        accountDate: row.AccountDate,
        activityShortName: row.Col1,
        reportCostCode: row.Col2,
        hoursDay3: row.HoursDay3,
      })),
    });
  } catch (error) {
    console.error("GET /api/dashboard failed:", error);

    return res.status(500).json({
      version: "time-intelligence-api-v2",
      ifsConnected: false,
      error: "Failed to connect to IFS",
      details:
        error instanceof Error ? error.message : String(error),
    });
  }
}
