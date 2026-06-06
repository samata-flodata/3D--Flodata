require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");

const app = express();

const PORT = Number(process.env.PORT || 5000);
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Attendance";
const DEFAULT_CORS_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5500",
  "https://attendance-server-1f81.onrender.com",
  "https://threed-flodata.onrender.com",
  "https://threed-model11.onrender.com",
];
const CORS_ORIGIN = process.env.CORS_ORIGIN || DEFAULT_CORS_ORIGINS.join(",");
const ALLOWED_ORIGINS = CORS_ORIGIN === "*"
  ? ["*"]
  : CORS_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean);
const ATTENDANCE_TIME_ZONE = "Asia/Kolkata";
const OFFICE_START_MINUTES_IST = 9 * 60 + 30;
const OFFICE_END_MINUTES_IST = 19 * 60 + 30;
const OFFICE_CENTER = {
  lat: Number(process.env.ATTENDANCE_BUILDING_LAT || "28.670903"),
  lng: Number(process.env.ATTENDANCE_BUILDING_LNG || "77.133783"),
};
const ATTENDANCE_CONFIG = {
  ENTER_RADIUS_METERS: Number(process.env.ATTENDANCE_ENTER_RADIUS_METERS || "15"),
  EXIT_RADIUS_METERS: Number(process.env.ATTENDANCE_EXIT_RADIUS_METERS || "25"),
  MAX_ACCURACY_METERS: Number(process.env.ATTENDANCE_MAX_ACCURACY_METERS || "25"),
  REQUIRED_SAMPLES: Number(process.env.ATTENDANCE_REQUIRED_SAMPLES || "5"),
  REQUIRED_DURATION_MS: Number(process.env.ATTENDANCE_REQUIRED_DURATION_MS || "30000"),
  MAX_SPEED_KMH: Number(process.env.ATTENDANCE_MAX_SPEED_KMH || "150"),
  MAX_SAMPLE_SPREAD_METERS: Number(process.env.ATTENDANCE_MAX_SAMPLE_SPREAD_METERS || "50"),
};
const ATTENDANCE_STATUSES = new Set([
  "VERIFIED",
  "LOW_ACCURACY",
  "SUSPICIOUS_SPEED",
  "LOCATION_INCONSISTENT",
  "AUTO_SIGNOUT",
]);
const ATTENDANCE_HEADERS = [
  "Email",
  "Name",
  "SignInTime",
  "SignOutTime",
  "TotalMinutes",
  "Latitude",
  "Longitude",
  "Accuracy",
  "Date",
  "Status",
  "SignInAltitude",
  "SignInAltitudeAccuracy",
  "SignOutAltitude",
  "SignOutAltitudeAccuracy",
];

app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`CORS blocked origin: ${origin}`));
  },
}));
app.use(express.json({ limit: "64kb" }));

const frontendDistPath = path.resolve(__dirname, "..", ".cesium_demo", "dist");
app.use(express.static(frontendDistPath));

app.use((req, res, next) => {
  if (req.path.startsWith("/api/attendance")) {
    console.log("[Attendance Request]", req.method, req.path, {
      origin: req.get("origin") || null,
      email: req.method === "GET" ? req.query.email : req.body?.email,
      accuracy: req.body?.accuracy,
      lat: req.body?.lat,
      lng: req.body?.lng,
      sampleCount: Array.isArray(req.body?.samples) ? req.body.samples.length : undefined,
    });
  }
  next();
});

function requiredString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requiredNumber(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${fieldName} must be a valid number`);
  }
  return number;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return "";
  const number = Number(value);
  return Number.isFinite(number) ? number : "";
}

function optionalStatus(value, fallback = "VERIFIED") {
  return ATTENDANCE_STATUSES.has(value) ? value : fallback;
}

function distanceMeters(a, b) {
  const radius = 6371008.8;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLon = (b.lng - a.lng) * Math.PI / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

function sampleSpreadMeters(samples) {
  const center = samples.reduce(
    (acc, sample) => ({ lat: acc.lat + sample.lat, lng: acc.lng + sample.lng }),
    { lat: 0, lng: 0 }
  );
  center.lat /= samples.length;
  center.lng /= samples.length;
  return Math.max(...samples.map((sample) => distanceMeters(sample, center)));
}

function validateAttendanceSamples(rawSamples) {
  if (!Array.isArray(rawSamples)) {
    return { ok: false, status: "LOCATION_INCONSISTENT", reason: "samples must be an array" };
  }

  const samples = rawSamples
    .map((sample) => ({
      lat: Number(sample.lat),
      lng: Number(sample.lng),
      accuracy: Number(sample.accuracy),
      timestamp: Number(sample.timestamp),
    }))
    .filter((sample) =>
      Number.isFinite(sample.lat) &&
      Number.isFinite(sample.lng) &&
      Number.isFinite(sample.accuracy) &&
      Number.isFinite(sample.timestamp)
    );

  if (samples.length < ATTENDANCE_CONFIG.REQUIRED_SAMPLES) {
    return {
      ok: false,
      status: "LOCATION_INCONSISTENT",
      reason: `not enough valid GPS samples: received ${samples.length}, required ${ATTENDANCE_CONFIG.REQUIRED_SAMPLES}`,
    };
  }

  const lastSamples = samples.slice(-ATTENDANCE_CONFIG.REQUIRED_SAMPLES);
  const duration = lastSamples[lastSamples.length - 1].timestamp - lastSamples[0].timestamp;
  if (duration < ATTENDANCE_CONFIG.REQUIRED_DURATION_MS) {
    return { ok: false, status: "LOCATION_INCONSISTENT", reason: "GPS samples were not collected over 30 seconds" };
  }

  for (const sample of lastSamples) {
    const distance = distanceMeters(sample, OFFICE_CENTER);
    console.log("[Attendance Validation] accuracy:", Math.round(sample.accuracy), "distance:", Math.round(distance));
    if (sample.accuracy > ATTENDANCE_CONFIG.MAX_ACCURACY_METERS) {
      return { ok: false, status: "LOW_ACCURACY", reason: `accuracy ${Math.round(sample.accuracy)}m exceeds limit` };
    }
    if (distance > ATTENDANCE_CONFIG.ENTER_RADIUS_METERS) {
      return { ok: false, status: "LOCATION_INCONSISTENT", reason: `sample outside office radius: ${Math.round(distance)}m` };
    }
  }

  for (let index = 1; index < lastSamples.length; index += 1) {
    const previous = lastSamples[index - 1];
    const current = lastSamples[index];
    const jumpMeters = distanceMeters(previous, current);
    const elapsedMs = current.timestamp - previous.timestamp;
    const speedKmh = jumpMeters / 1000 / Math.max(0.000001, elapsedMs / 3600000);
    console.log("[Attendance Validation] speed:", Math.round(speedKmh), "km/h");

    if (speedKmh > ATTENDANCE_CONFIG.MAX_SPEED_KMH || (jumpMeters > 2000 && elapsedMs <= 30000)) {
      return { ok: false, status: "SUSPICIOUS_SPEED", reason: `suspicious GPS movement: ${Math.round(speedKmh)} km/h` };
    }
  }

  const spread = sampleSpreadMeters(lastSamples);
  console.log("[Attendance Validation] sample spread:", Math.round(spread), "m");
  if (spread > ATTENDANCE_CONFIG.MAX_SAMPLE_SPREAD_METERS) {
    return { ok: false, status: "LOCATION_INCONSISTENT", reason: `GPS samples scattered ${Math.round(spread)}m` };
  }

  return { ok: true, status: "VERIFIED", reason: "verified" };
}

function todayDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: ATTENDANCE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function attendanceDateTimeString(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: ATTENDANCE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).replace(",", "") + " IST";
}

function parseAttendanceDateTime(value) {
  const match = String(value).match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+IST$/);
  if (match) {
    const [, day, month, year, hour, minute, second] = match;
    return Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour) - 5,
      Number(minute) - 30,
      Number(second)
    );
  }
  return Date.parse(value);
}

function minutesBetween(startValue, endDate) {
  const start = parseAttendanceDateTime(startValue);
  const end = endDate.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 60000);
}

function istParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: ATTENDANCE_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function istMinutesSinceMidnight(date = new Date()) {
  const parts = istParts(date);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function isWithinOfficeHours(date = new Date()) {
  const minutes = istMinutesSinceMidnight(date);
  return minutes >= OFFICE_START_MINUTES_IST && minutes < OFFICE_END_MINUTES_IST;
}

async function getSheetsClient() {
  if (!SPREADSHEET_ID) {
    throw new Error("SPREADSHEET_ID is not configured");
  }

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

async function ensureAttendanceHeader(sheets) {
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:N1`,
  });
  const current = result.data.values?.[0] || [];
  const needsUpdate = ATTENDANCE_HEADERS.some((header, index) => current[index] !== header);

  if (!needsUpdate) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:N1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [ATTENDANCE_HEADERS] },
  });
  console.log("[Attendance] header row synced");
}

async function findLatestOpenSignInRow(sheets, email) {
  const readResult = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:N`,
  });

  const rows = readResult.data.values || [];
  for (let index = rows.length - 1; index >= 1; index -= 1) {
    const row = rows[index];
    const rowEmail = String(row[0] || "").trim().toLowerCase();
    const signOut = String(row[3] || "").trim();
    if (rowEmail === email && signOut === "") {
      return { row, rowNumber: index + 1 };
    }
  }

  return null;
}

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/attendance/status", async (req, res) => {
  try {
    const email = requiredString(req.query.email, "email").toLowerCase();
    const sheets = await getSheetsClient();
    await ensureAttendanceHeader(sheets);
    const openSignIn = await findLatestOpenSignInRow(sheets, email);
    console.log("[Attendance Status]", email, {
      signedIn: Boolean(openSignIn),
      rowNumber: openSignIn?.rowNumber || null,
      signInTime: openSignIn?.row?.[2] || null,
    });

    res.json({
      ok: true,
      signedIn: Boolean(openSignIn),
      rowNumber: openSignIn?.rowNumber,
      signInTime: openSignIn?.row?.[2] || null,
    });
  } catch (error) {
    console.error("[Attendance Status Error]", error);

    res.status(500).json({
      ok: false,
      route: "/api/attendance/status",
      error: error.message,
      code: error.code || null,
      details: error.errors || null,
    });
  }
});

app.post("/api/attendance/signin", async (req, res) => {
  try {
    const email = requiredString(req.body.email, "email").toLowerCase();
    const name = optionalString(req.body.name);
    const lat = requiredNumber(req.body.lat, "lat");
    const lng = requiredNumber(req.body.lng, "lng");
    const accuracy = requiredNumber(req.body.accuracy, "accuracy");
    const altitude = optionalNumber(req.body.altitude);
    const altitudeAccuracy = optionalNumber(req.body.altitudeAccuracy);
    const now = new Date();
    const signInTime = attendanceDateTimeString(now);
    const distance = distanceMeters({ lat, lng }, OFFICE_CENTER);

    console.log("[Attendance SignIn] received", email, {
      sheetName: SHEET_NAME,
      spreadsheetIdSuffix: SPREADSHEET_ID ? SPREADSHEET_ID.slice(-6) : null,
      signInTime,
      accuracy: Math.round(accuracy),
      distance: Math.round(distance),
      sampleCount: Array.isArray(req.body.samples) ? req.body.samples.length : 0,
    });

    if (!isWithinOfficeHours(now)) {
      res.status(403).json({
        ok: false,
        error: "Attendance sign-in is allowed only from 09:30 to 19:30 IST",
      });
      return;
    }

    const validation = validateAttendanceSamples(req.body.samples);
    console.log("[Attendance Validation] sign-in:", email, validation.status, validation.reason);
    if (!validation.ok) {
      res.status(403).json({ ok: false, error: validation.reason, status: validation.status });
      return;
    }

    const sheets = await getSheetsClient();
    await ensureAttendanceHeader(sheets);
    const appendResult = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:N`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          email,
          name,
          signInTime,
          "",
          "",
          lat,
          lng,
          accuracy,
          todayDateString(now),
          validation.status,
          altitude,
          altitudeAccuracy,
          "",
          "",
        ]],
      },
    });

    console.log("[Attendance] sign-in saved:", email, {
      updatedRange: appendResult.data.updates?.updatedRange || null,
      updatedRows: appendResult.data.updates?.updatedRows || null,
    });
    res.status(201).json({
      ok: true,
      message: "Sign-in saved",
      updatedRange: appendResult.data.updates?.updatedRange,
    });
  } catch (error) {
    console.error("[Attendance Signin Error]", error);

    res.status(500).json({
      ok: false,
      route: "/api/attendance/signin",
      error: error.message,
      code: error.code || null,
      details: error.errors || null,
    });
  }
});

app.post("/api/attendance/signout", async (req, res) => {
  try {
    const email = requiredString(req.body.email, "email").toLowerCase();
    const lat = requiredNumber(req.body.lat, "lat");
    const lng = requiredNumber(req.body.lng, "lng");
    const accuracy = requiredNumber(req.body.accuracy, "accuracy");
    const altitude = optionalNumber(req.body.altitude);
    const altitudeAccuracy = optionalNumber(req.body.altitudeAccuracy);
    const status = optionalStatus(req.body.status, "VERIFIED");
    const now = new Date();
    const signOutTime = attendanceDateTimeString(now);
    const distance = distanceMeters({ lat, lng }, OFFICE_CENTER);
    console.log(
      "[Attendance Validation] sign-out:",
      email,
      "accuracy:",
      Math.round(accuracy),
      "distance:",
      Math.round(distance),
      "status:",
      status
    );

    const sheets = await getSheetsClient();
    await ensureAttendanceHeader(sheets);
    const openSignIn = await findLatestOpenSignInRow(sheets, email);
    if (!openSignIn) {
      res.status(404).json({ ok: false, error: "No open sign-in row found for this email" });
      return;
    }

    const row = openSignIn.row;
    const signInTime = row[2];
    const totalMinutes = minutesBetween(signInTime, now);
    const rowNumber = openSignIn.rowNumber;
    const dateValue = row[8] || todayDateString(now);

    const updateResult = await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!D${rowNumber}:J${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[signOutTime, totalMinutes, lat, lng, accuracy, dateValue, status]],
      },
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!M${rowNumber}:N${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[altitude, altitudeAccuracy]],
      },
    });

    console.log("[Attendance] sign-out saved:", email, {
      rowNumber,
      totalMinutes,
      updatedRange: updateResult.data.updatedRange || null,
    });
    res.json({
      ok: true,
      message: "Sign-out saved",
      totalMinutes,
      rowNumber,
      updatedRange: updateResult.data.updatedRange,
    });
  } catch (error) {
    console.error("[Attendance Signout Error]", error);

    res.status(500).json({
      ok: false,
      route: "/api/attendance/signout",
      error: error.message,
      code: error.code || null,
      details: error.errors || null,
    });
  }
});

app.use((err, req, res, next) => {
  const status = err.message && (err.message.includes("required") || err.message.includes("valid number"))
    ? 400
    : err.status || err.code || 500;
  const googleError = err.errors?.[0]?.message || err.response?.data?.error?.message;
  const message = googleError || err.message || "Internal server error";
  console.error("[Server]", err);
  res.status(status).json({
    ok: false,
    error: status >= 500 ? "Internal server error" : message,
    details: status >= 500 ? message : undefined,
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(frontendDistPath, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Attendance server listening on http://localhost:${PORT}`);
  console.log("[Attendance Config]", ATTENDANCE_CONFIG);
});
