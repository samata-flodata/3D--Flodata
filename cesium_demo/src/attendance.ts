import {
  ATTENDANCE_API_BASE_URL,
  ATTENDANCE_BUILDING_CENTER,
  ATTENDANCE_ENTER_RADIUS_METERS,
  ATTENDANCE_EXIT_RADIUS_METERS,
  ATTENDANCE_MAX_ACCURACY_METERS,
} from "./config";
import { ATTENDANCE_CONFIG } from "./attendanceConfig";
import { showToast } from "./booking";

type AttendanceUser = {
  email: string;
  name?: string;
};

type AttendanceStatus = {
  active: boolean;
  inside: boolean;
  text: string;
};

type StoredAttendanceState = {
  signedIn: boolean;
  signedInAt?: string;
  email?: string;
};

type AttendanceFlag =
  | "VERIFIED"
  | "LOW_ACCURACY"
  | "SUSPICIOUS_SPEED"
  | "LOCATION_INCONSISTENT"
  | "AUTO_SIGNOUT";

type AttendanceSample = {
  lat: number;
  lng: number;
  accuracy: number;
  altitude: number | null;
  altitudeAccuracy: number | null;
  elevationDelta: number | null;
  elevationSource: "barometer" | "gps" | "motion" | "none";
  timestamp: number;
  distanceFromOffice: number;
  speedKmh: number | null;
};

type AttendanceServerStatus = {
  ok: boolean;
  signedIn: boolean;
  signInTime?: string | null;
};

const STORAGE_KEY = "attendance_geofence_state";
const AUTO_SIGN_OUT_EVENT = "attendance:auto-signout";
const ATTENDANCE_TIME_ZONE = "Asia/Kolkata";
const OFFICE_START_MINUTES_IST = 9 * 60 + 30;
const OFFICE_END_MINUTES_IST = 19 * 60 + 30;
const ELEVATION_DECIMAL_PLACES = 3;
const MOTION_NOISE_FLOOR = 0.035;
const MOTION_VELOCITY_DAMPING = 0.82;

let watchId: number | null = null;
let activeUser: AttendanceUser | null = null;
let outsideSamples = 0;
let requestInFlight = false;
let attendanceState: StoredAttendanceState = readAttendanceState();
let lastPosition: GeolocationPosition | null = null;
let officeEndTimer: ReturnType<typeof setTimeout> | null = null;
let verificationSamples: AttendanceSample[] = [];
let previousSample: AttendanceSample | null = null;
let lastAltitudeMeters: number | null = null;
let pressureSensor: PressureSensor | null = null;
let baselinePressureHpa: number | null = null;
let currentBarometerAltitudeMeters: number | null = null;
let lastBarometerAltitudeMeters: number | null = null;
let motionAltitudeMeters = 0;
let lastMotionAltitudeMeters: number | null = null;
let motionVelocityMetersPerSecond = 0;
let motionBaselineAcceleration: number | null = null;
let lastMotionTimestampMs: number | null = null;
let motionSensorActive = false;
let stateSyncInFlight = false;

function readAttendanceState(): StoredAttendanceState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as StoredAttendanceState : { signedIn: false };
  } catch {
    return { signedIn: false };
  }
}

function saveAttendanceState(state: StoredAttendanceState): void {
  attendanceState = state;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function clearAttendanceState(): void {
  attendanceState = { signedIn: false };
  localStorage.removeItem(STORAGE_KEY);
}

function statusElement(): HTMLElement | null {
  return document.getElementById("attendanceStatus");
}

function buttonElement(): HTMLButtonElement | null {
  return document.getElementById("attendanceStartBtn") as HTMLButtonElement | null;
}

function setText(id: string, value: string): void {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function setAttendanceStatus(status: AttendanceStatus): void {
  const node = statusElement();
  if (node) {
    node.textContent = status.text;
    node.dataset.active = String(status.active);
    node.dataset.inside = String(status.inside);
  }
}

function setMetrics(values: {
  accuracy?: number;
  distance?: number;
  latitude?: number;
  longitude?: number;
  altitude?: number | null;
  altitudeAccuracy?: number | null;
  elevationDelta?: number | null;
  speedKmh?: number | null;
  updatedAt?: number;
  progress?: string;
  status?: AttendanceFlag | "WAITING" | "VERIFYING" | "SIGNED_IN" | "SIGNED_OUT";
  lastSignIn?: string;
}): void {
  if (typeof values.accuracy === "number") setText("attendanceAccuracy", `${Math.round(values.accuracy)}m`);
  if (typeof values.distance === "number") setText("attendanceDistance", `${Math.round(values.distance)}m`);
  if (typeof values.latitude === "number") setText("attendanceLatitude", values.latitude.toFixed(7));
  if (typeof values.longitude === "number") setText("attendanceLongitude", values.longitude.toFixed(7));
  if (values.altitude === null) setText("attendanceAltitude", "Not available");
  if (typeof values.altitude === "number") setText("attendanceAltitude", `${values.altitude.toFixed(ELEVATION_DECIMAL_PLACES)}m`);
  if (values.altitudeAccuracy === null) setText("attendanceAltitudeAccuracy", "Not available");
  if (typeof values.altitudeAccuracy === "number") setText("attendanceAltitudeAccuracy", `+/-${values.altitudeAccuracy.toFixed(ELEVATION_DECIMAL_PLACES)}m`);
  if (values.elevationDelta === null) setText("attendanceElevationDelta", "--");
  if (typeof values.elevationDelta === "number") {
    const sign = values.elevationDelta > 0 ? "+" : "";
    setText("attendanceElevationDelta", `${sign}${values.elevationDelta.toFixed(ELEVATION_DECIMAL_PLACES)}m`);
  }
  if (values.speedKmh === null) setText("attendanceSpeed", "--");
  if (typeof values.speedKmh === "number") setText("attendanceSpeed", `${values.speedKmh.toFixed(1)} km/h`);
  if (typeof values.updatedAt === "number") setText("attendanceLastGpsUpdate", new Date(values.updatedAt).toLocaleTimeString());
  if (values.progress) setText("attendanceProgress", values.progress);
  if (values.status) {
    const badge = document.getElementById("attendanceCurrentStatus");
    const labelMap: Record<string, { text: string; bg: string; color: string }> = {
      WAITING:               { text: "Inactive",   bg: "#f1f5f9", color: "#475569" },
      VERIFYING:             { text: "Verifying…", bg: "#fef9c3", color: "#854d0e" },
      SIGNED_IN:             { text: "Signed In",  bg: "#dcfce7", color: "#15803d" },
      VERIFIED:              { text: "Signed In",  bg: "#dcfce7", color: "#15803d" },
      SIGNED_OUT:            { text: "Signed Out", bg: "#fee2e2", color: "#b91c1c" },
      AUTO_SIGNOUT:          { text: "Auto Sign-Out", bg: "#fee2e2", color: "#b91c1c" },
      LOW_ACCURACY:          { text: "Poor GPS",   bg: "#fef3c7", color: "#92400e" },
      SUSPICIOUS_SPEED:      { text: "Suspicious", bg: "#fef3c7", color: "#92400e" },
      LOCATION_INCONSISTENT: { text: "Bad Location", bg: "#fef3c7", color: "#92400e" },
    };
    const style = labelMap[values.status] ?? { text: values.status, bg: "#f1f5f9", color: "#475569" };
    if (badge) {
      badge.textContent = style.text;
      (badge as HTMLElement).style.background = style.bg;
      (badge as HTMLElement).style.color = style.color;
    }
  }
  if (values.lastSignIn) setText("attendanceLastSignIn", values.lastSignIn);
}

function updateButton(): void {
  const button = buttonElement();
  if (!button) return;
  button.disabled = !activeUser;
  if (attendanceState.signedIn) {
    button.textContent = "Sign Out Attendance";
    return;
  }
  button.textContent = watchId === null ? "Start Attendance" : "Stop Attendance";
}

function attendanceApiUrl(path: string): string {
  return `${ATTENDANCE_API_BASE_URL.replace(/\/$/, "")}${path}`;
}

function distanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const radius = 6371008.8;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

function sampleSpreadMeters(samples: AttendanceSample[]): number {
  if (samples.length === 0) return 0;
  // Use the last verified cluster center to reject scattered or spoofed GPS readings.
  const average = samples.reduce(
    (acc, sample) => ({ lat: acc.lat + sample.lat, lon: acc.lon + sample.lng }),
    { lat: 0, lon: 0 }
  );
  const center = { lat: average.lat / samples.length, lon: average.lon / samples.length };
  return Math.max(...samples.map((sample) => distanceMeters({ lat: sample.lat, lon: sample.lng }, center)));
}

function resetVerification(reason?: AttendanceFlag): void {
  verificationSamples = [];
  if (reason) setMetrics({ progress: `0/${ATTENDANCE_CONFIG.REQUIRED_SAMPLES} samples`, status: reason });
}

function pressureToAltitudeDeltaMeters(pressureHpa: number, referencePressureHpa: number): number {
  return 44330 * (1 - Math.pow(pressureHpa / referencePressureHpa, 1 / 5.255));
}

function handlePressureReading(): void {
  if (!pressureSensor) return;
  const pressure = pressureSensor.pressure;
  if (!Number.isFinite(pressure) || pressure <= 0) return;

  if (baselinePressureHpa === null) {
    baselinePressureHpa = pressure;
  }
  currentBarometerAltitudeMeters = pressureToAltitudeDeltaMeters(pressure, baselinePressureHpa);
}

function resetMotionElevation(): void {
  motionAltitudeMeters = 0;
  lastMotionAltitudeMeters = null;
  motionVelocityMetersPerSecond = 0;
  motionBaselineAcceleration = null;
  lastMotionTimestampMs = null;
}

function requestMotionPermissionIfNeeded(): void {
  const motionEvent = DeviceMotionEvent as typeof DeviceMotionEvent & {
    requestPermission?: () => Promise<PermissionState>;
  };

  if (typeof motionEvent.requestPermission !== "function") return;

  motionEvent.requestPermission()
    .then((state) => {
      if (state !== "granted") {
        console.warn("[Attendance] device motion permission not granted:", state);
      }
    })
    .catch((error) => {
      console.warn("[Attendance] device motion permission failed:", error);
    });
}

function handleDeviceMotion(event: DeviceMotionEvent): void {
  const acceleration = event.accelerationIncludingGravity ?? event.acceleration;
  const zAcceleration = acceleration?.z;
  if (typeof zAcceleration !== "number" || !Number.isFinite(zAcceleration)) return;

  const timestamp = performance.now();
  if (motionBaselineAcceleration === null) {
    motionBaselineAcceleration = zAcceleration;
    lastMotionTimestampMs = timestamp;
    return;
  }
  if (lastMotionTimestampMs === null) {
    lastMotionTimestampMs = timestamp;
    return;
  }

  const elapsedSeconds = Math.min(0.2, Math.max(0.001, (timestamp - lastMotionTimestampMs) / 1000));
  lastMotionTimestampMs = timestamp;

  motionBaselineAcceleration = (motionBaselineAcceleration * 0.995) + (zAcceleration * 0.005);
  let verticalAcceleration = zAcceleration - motionBaselineAcceleration;
  if (Math.abs(verticalAcceleration) < MOTION_NOISE_FLOOR) {
    verticalAcceleration = 0;
  }

  motionVelocityMetersPerSecond = (motionVelocityMetersPerSecond + verticalAcceleration * elapsedSeconds) * MOTION_VELOCITY_DAMPING;
  if (Math.abs(motionVelocityMetersPerSecond) < 0.002) {
    motionVelocityMetersPerSecond = 0;
  }
  motionAltitudeMeters += motionVelocityMetersPerSecond * elapsedSeconds;

  if (Math.abs(motionAltitudeMeters) < 0.001 && motionVelocityMetersPerSecond === 0) {
    motionAltitudeMeters = 0;
  }
}

function startElevationSensor(): void {
  if (!motionSensorActive && "DeviceMotionEvent" in window) {
    requestMotionPermissionIfNeeded();
    window.addEventListener("devicemotion", handleDeviceMotion);
    motionSensorActive = true;
    console.log("[Attendance] motion elevation sensor started");
  }

  if (pressureSensor || !window.PressureSensor) return;

  try {
    pressureSensor = new window.PressureSensor({ frequency: 5 });
    pressureSensor.addEventListener("reading", handlePressureReading);
    pressureSensor.addEventListener("error", (event) => {
      console.warn("[Attendance] barometer unavailable:", event);
    });
    pressureSensor.start();
    console.log("[Attendance] barometer elevation sensor started");
  } catch (error) {
    pressureSensor = null;
    console.warn("[Attendance] could not start barometer elevation sensor:", error);
  }
}

function stopElevationSensor(): void {
  if (pressureSensor) {
    pressureSensor.stop();
    pressureSensor = null;
  }
  baselinePressureHpa = null;
  currentBarometerAltitudeMeters = null;
  lastBarometerAltitudeMeters = null;
  if (motionSensorActive) {
    window.removeEventListener("devicemotion", handleDeviceMotion);
    motionSensorActive = false;
  }
  resetMotionElevation();
}

function buildSample(position: GeolocationPosition): AttendanceSample {
  const timestamp = position.timestamp || Date.now();
  const lat = position.coords.latitude;
  const lng = position.coords.longitude;
  const gpsAltitude = position.coords.altitude;
  const gpsAltitudeAccuracy = position.coords.altitudeAccuracy;
  const barometerAltitude = currentBarometerAltitudeMeters;
  const hasBarometerAltitude = barometerAltitude !== null;
  const motionDelta = lastMotionAltitudeMeters === null ? null : motionAltitudeMeters - lastMotionAltitudeMeters;
  const hasMotionAltitude = motionSensorActive && motionBaselineAcceleration !== null && motionDelta !== null && Math.abs(motionDelta) >= 0.001;
  const altitude = hasBarometerAltitude ? barometerAltitude : hasMotionAltitude ? motionAltitudeMeters : gpsAltitude;
  const altitudeAccuracy = hasBarometerAltitude || hasMotionAltitude ? null : gpsAltitudeAccuracy;
  const elevationSource: AttendanceSample["elevationSource"] = hasBarometerAltitude
    ? "barometer"
    : hasMotionAltitude ? "motion" : typeof gpsAltitude === "number" ? "gps" : "none";
  const distanceFromOffice = distanceMeters({ lat, lon: lng }, ATTENDANCE_BUILDING_CENTER);
  let speedKmh: number | null = null;
  const elevationDelta = hasBarometerAltitude
    ? lastBarometerAltitudeMeters === null ? null : barometerAltitude - lastBarometerAltitudeMeters
    : hasMotionAltitude ? motionDelta
      : typeof gpsAltitude === "number" && lastAltitudeMeters !== null ? gpsAltitude - lastAltitudeMeters : null;

  if (previousSample) {
    // Speed and jump checks catch fake-location jumps and impossible movement.
    const jumpMeters = distanceMeters({ lat: previousSample.lat, lon: previousSample.lng }, { lat, lon: lng });
    const elapsedHours = Math.max(0.000001, (timestamp - previousSample.timestamp) / 3600000);
    speedKmh = jumpMeters / 1000 / elapsedHours;

    if (speedKmh > ATTENDANCE_CONFIG.MAX_SPEED_KMH) {
      console.warn("[Attendance] Suspicious speed:", Math.round(speedKmh), "km/h");
    }
    if (jumpMeters > 2000 && timestamp - previousSample.timestamp <= 30000) {
      console.warn("[Attendance] Suspicious GPS jump:", Math.round(jumpMeters), "m in", timestamp - previousSample.timestamp, "ms");
    }
  }

  if (hasBarometerAltitude) {
    lastBarometerAltitudeMeters = barometerAltitude;
  }

  lastMotionAltitudeMeters = motionAltitudeMeters;

  if (typeof gpsAltitude === "number") {
    lastAltitudeMeters = gpsAltitude;
  }

  const sample = {
    lat,
    lng,
    accuracy: position.coords.accuracy,
    altitude,
    altitudeAccuracy,
    elevationDelta,
    elevationSource,
    timestamp,
    distanceFromOffice,
    speedKmh
  };
  previousSample = sample;
  return sample;
}

function istDateParts(date = new Date()): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: ATTENDANCE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function istMinutesSinceMidnight(date = new Date()): number {
  const parts = istDateParts(date);
  return parts.hour * 60 + parts.minute;
}

function isWithinOfficeHours(date = new Date()): boolean {
  const minutes = istMinutesSinceMidnight(date);
  return minutes >= OFFICE_START_MINUTES_IST && minutes < OFFICE_END_MINUTES_IST;
}

function nextOfficeEndDelayMs(date = new Date()): number {
  const parts = istDateParts(date);
  let end = Date.UTC(parts.year, parts.month - 1, parts.day, 14, 0, 0, 0);
  if (date.getTime() >= end) end += 24 * 60 * 60 * 1000;
  return Math.max(0, end - date.getTime());
}

function clearOfficeEndTimer(): void {
  if (officeEndTimer !== null) {
    clearTimeout(officeEndTimer);
    officeEndTimer = null;
  }
}

function scheduleOfficeEndSignOut(): void {
  clearOfficeEndTimer();
  officeEndTimer = setTimeout(() => {
    void signOutAtOfficeEnd();
  }, nextOfficeEndDelayMs());
}

async function postAttendance(path: "/api/attendance/signin" | "/api/attendance/signout", body: Record<string, unknown>): Promise<void> {
  const url = attendanceApiUrl(path);
  console.log("[Attendance API] POST", url, {
    email: body.email,
    accuracy: body.accuracy,
    lat: body.lat,
    lng: body.lng,
    status: body.status,
    sampleCount: Array.isArray(body.samples) ? body.samples.length : undefined,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null) as { ok?: boolean; error?: string; message?: string; rowNumber?: number; updatedRange?: string } | null;

  console.log("[Attendance API] response", path, response.status, data);

  if (!response.ok) {
    throw new Error(data?.error ?? `Attendance API failed with ${response.status}`);
  }
  if (!data || data.ok !== true) {
    throw new Error("Attendance API returned no JSON confirmation. Check Render backend deployment.");
  }
}

async function fetchAttendanceStatus(email: string): Promise<AttendanceServerStatus> {
  const url = attendanceApiUrl(`/api/attendance/status?email=${encodeURIComponent(email)}`);
  console.log("[Attendance API] GET", url);
  const response = await fetch(url);
  const data = await response.json().catch(() => null) as AttendanceServerStatus | { error?: string } | null;
  console.log("[Attendance API] status response", response.status, data);

  if (!response.ok || !data || !("signedIn" in data)) {
    throw new Error(data && "error" in data ? data.error : `Attendance status API failed with ${response.status}`);
  }

  return data;
}

async function syncAttendanceStateWithServer(email: string): Promise<void> {
  if (stateSyncInFlight) return;
  stateSyncInFlight = true;

  try {
    const status = await fetchAttendanceStatus(email);

    if (status.signedIn) {
      if (!attendanceState.signedIn || attendanceState.email !== email) {
        saveAttendanceState({ signedIn: true, signedInAt: new Date().toISOString(), email });
      }
      scheduleOfficeEndSignOut();
      setMetrics({ status: "SIGNED_IN" });
      console.log("[Attendance] confirmed open sign-in row in Google Sheet");
      return;
    }

    if (attendanceState.signedIn && attendanceState.email === email) {
      console.warn("[Attendance] cleared stale local sign-in state; no open Google Sheet row found");
      clearAttendanceState();
      clearOfficeEndTimer();
      resetVerification();
      setMetrics({ progress: `0/${ATTENDANCE_CONFIG.REQUIRED_SAMPLES} samples`, status: "WAITING", lastSignIn: "--" });
    }
  } catch (error) {
    console.warn("[Attendance] could not verify Google Sheet sign-in state:", error);
  } finally {
    stateSyncInFlight = false;
  }
}

async function saveSignIn(position: GeolocationPosition, verifiedSamples = verificationSamples): Promise<void> {
  if (!activeUser || requestInFlight || attendanceState.signedIn) return;
  requestInFlight = true;

  try {
    const samples = verifiedSamples.map((sample) => ({ ...sample }));
    await postAttendance("/api/attendance/signin", {
      email: activeUser.email,
      name: activeUser.name ?? "",
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy,
      altitude: previousSample?.altitude ?? position.coords.altitude,
      altitudeAccuracy: previousSample?.altitudeAccuracy ?? position.coords.altitudeAccuracy,
      status: "VERIFIED",
      samples,
    });
    const signedInAt = new Date().toISOString();
    saveAttendanceState({ signedIn: true, signedInAt, email: activeUser.email });
    scheduleOfficeEndSignOut();
    resetVerification();
    console.log("[Attendance] sign-in saved");
    setMetrics({ status: "VERIFIED", lastSignIn: new Date().toLocaleTimeString() });
    setAttendanceStatus({ active: true, inside: true, text: "Signed in. Attendance saved." });
    showToast("Attendance sign-in saved.", "success");
  } finally {
    requestInFlight = false;
  }
}

async function saveSignOut(position: GeolocationPosition, status: AttendanceFlag = "VERIFIED"): Promise<void> {
  if (!activeUser || requestInFlight || !attendanceState.signedIn) return;
  requestInFlight = true;

  try {
    await postAttendance("/api/attendance/signout", {
      email: activeUser.email,
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy,
      altitude: previousSample?.altitude ?? position.coords.altitude,
      altitudeAccuracy: previousSample?.altitudeAccuracy ?? position.coords.altitudeAccuracy,
      status,
    });
    clearAttendanceState();
    clearOfficeEndTimer();
    resetVerification();
    console.log("[Attendance] sign-out saved");
    setMetrics({ progress: `0/${ATTENDANCE_CONFIG.REQUIRED_SAMPLES} samples`, status: status === "AUTO_SIGNOUT" ? "AUTO_SIGNOUT" : "SIGNED_OUT" });
    setAttendanceStatus({ active: true, inside: false, text: "Signed out. Attendance saved." });
    showToast("Attendance sign-out saved.", "success");
  } finally {
    requestInFlight = false;
  }
}

async function signOutAtOfficeEnd(): Promise<void> {
  if (!activeUser || !attendanceState.signedIn) return;

  try {
    const position = lastPosition ?? await getCurrentPositionOnce();
    await saveSignOut(position, "AUTO_SIGNOUT");
    window.dispatchEvent(new CustomEvent(AUTO_SIGN_OUT_EVENT));
  } catch (error) {
    console.error("[Attendance] 19:30 IST auto sign-out failed:", error);
    showToast("Attendance auto sign-out failed at 19:30 IST. Check backend logs.", "error");
  }
}

function getCurrentPositionOnce(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("GPS is not available in this browser."));
      return;
    }

    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000,
    });
  });
}

async function handlePosition(position: GeolocationPosition): Promise<void> {
  if (!activeUser) return;
  lastPosition = position;

  const sample = buildSample(position);
  const hasGoodAccuracy = sample.accuracy <= ATTENDANCE_MAX_ACCURACY_METERS;

  console.log("[Attendance] GPS accuracy:", Math.round(sample.accuracy), "m");
  console.log("[Attendance] GPS lat/lng:", sample.lat, sample.lng);
  console.log("[Attendance] elevation source:", sample.elevationSource);
  console.log("[Attendance] GPS altitude:", sample.altitude === null ? "n/a" : `${sample.altitude.toFixed(ELEVATION_DECIMAL_PLACES)}m`);
  console.log("[Attendance] GPS altitude accuracy:", sample.altitudeAccuracy === null ? "n/a" : `+/-${sample.altitudeAccuracy.toFixed(ELEVATION_DECIMAL_PLACES)}m`);
  console.log("[Attendance] elevation delta:", sample.elevationDelta === null ? "n/a" : `${sample.elevationDelta.toFixed(ELEVATION_DECIMAL_PLACES)}m`);
  console.log("[Attendance] distance from office:", Math.round(sample.distanceFromOffice), "m");
  console.log("[Attendance] speed:", sample.speedKmh === null ? "n/a" : `${Math.round(sample.speedKmh)} km/h`);
  console.log("[Attendance] sample count:", verificationSamples.length);

  setMetrics({
    accuracy: sample.accuracy,
    distance: sample.distanceFromOffice,
    latitude: sample.lat,
    longitude: sample.lng,
    altitude: sample.altitude,
    altitudeAccuracy: sample.altitudeAccuracy,
    elevationDelta: sample.elevationDelta,
    speedKmh: sample.speedKmh,
    updatedAt: sample.timestamp,
    progress: `${verificationSamples.length}/${ATTENDANCE_CONFIG.REQUIRED_SAMPLES} samples`,
    status: attendanceState.signedIn ? "SIGNED_IN" : "WAITING",
  });

  if (!hasGoodAccuracy) {
    resetVerification("LOW_ACCURACY");
    setAttendanceStatus({
      active: true,
      inside: attendanceState.signedIn,
      text: `Waiting for better GPS accuracy. Current: ${Math.round(sample.accuracy)}m`,
    });
    return;
  }

  if (sample.speedKmh !== null && sample.speedKmh > ATTENDANCE_CONFIG.MAX_SPEED_KMH) {
    resetVerification("SUSPICIOUS_SPEED");
    setAttendanceStatus({ active: true, inside: false, text: "Suspicious GPS speed detected. Re-verifying location." });
    return;
  }

  if (previousSample && distanceMeters({ lat: previousSample.lat, lon: previousSample.lng }, { lat: sample.lat, lon: sample.lng }) > 2000) {
    resetVerification("SUSPICIOUS_SPEED");
    setAttendanceStatus({ active: true, inside: false, text: "Suspicious GPS jump detected. Re-verifying location." });
    return;
  }

  if (!attendanceState.signedIn) {
    if (!isWithinOfficeHours()) {
      resetVerification();
      setAttendanceStatus({ active: true, inside: false, text: "Outside attendance hours. Sign-in opens at 09:30 IST." });
      return;
    }

    if (sample.distanceFromOffice > ATTENDANCE_ENTER_RADIUS_METERS) {
      resetVerification();
      setAttendanceStatus({ active: true, inside: false, text: `Outside building. Distance: ${Math.round(sample.distanceFromOffice)}m.` });
      return;
    }

    verificationSamples.push(sample);
    verificationSamples = verificationSamples.slice(-ATTENDANCE_CONFIG.REQUIRED_SAMPLES);
    const progress = `${verificationSamples.length}/${ATTENDANCE_CONFIG.REQUIRED_SAMPLES} samples`;
    setMetrics({ progress, status: "VERIFYING" });
    setAttendanceStatus({ active: true, inside: true, text: `Verifying location (${progress})...` });

    if (verificationSamples.length < ATTENDANCE_CONFIG.REQUIRED_SAMPLES) return;

    // A user must remain consistently inside the geofence for the full verification window.
    const duration = verificationSamples[verificationSamples.length - 1].timestamp - verificationSamples[0].timestamp;
    if (duration < ATTENDANCE_CONFIG.REQUIRED_DURATION_MS) return;

    if (sampleSpreadMeters(verificationSamples) > ATTENDANCE_CONFIG.MAX_SAMPLE_SPREAD_METERS) {
      console.warn("[Attendance] Location inconsistent. Spread:", Math.round(sampleSpreadMeters(verificationSamples)), "m");
      resetVerification("LOCATION_INCONSISTENT");
      setAttendanceStatus({ active: true, inside: false, text: "Location samples are inconsistent. Re-verifying." });
      return;
    }

    try {
      await saveSignIn(position, verificationSamples);
    } catch (error) {
      console.error("[Attendance] sign-in failed:", error);
      showToast("Attendance sign-in failed. Check backend logs.", "error");
    }
    return;
  }

  if (sample.distanceFromOffice >= ATTENDANCE_EXIT_RADIUS_METERS) {
    outsideSamples += 1;
  } else {
    outsideSamples = 0;
  }

  setAttendanceStatus({ active: true, inside: true, text: `Inside building. Distance: ${Math.round(sample.distanceFromOffice)}m.` });

  if (outsideSamples >= 2) {
    outsideSamples = 0;
    try {
      await saveSignOut(position, "AUTO_SIGNOUT");
      window.dispatchEvent(new CustomEvent(AUTO_SIGN_OUT_EVENT));
    } catch (error) {
      console.error("[Attendance] sign-out failed:", error);
      showToast("Attendance sign-out failed. Check backend logs.", "error");
    }
  }
}

function handlePositionError(error: GeolocationPositionError): void {
  const text = error.code === error.PERMISSION_DENIED
    ? "Allow location permission to use attendance."
    : "Could not read current location for attendance.";
  console.error("[Attendance] GPS error:", error.message);
  setAttendanceStatus({ active: false, inside: attendanceState.signedIn, text });
  showToast(text, "error");
}

export function startAttendanceTracking(email: string, name = ""): void {
  activeUser = { email, name };

  if (!navigator.geolocation) {
    setAttendanceStatus({ active: false, inside: false, text: "GPS is not available in this browser." });
    updateButton();
    return;
  }

  if (watchId !== null) {
    updateButton();
    return;
  }

  if (attendanceState.email && attendanceState.email !== email) {
    clearAttendanceState();
    resetVerification();
  }

  console.log("[Attendance] tracking started for", email);
  startElevationSensor();
  if (attendanceState.signedIn) scheduleOfficeEndSignOut();
  void syncAttendanceStateWithServer(email);
  setMetrics({
    progress: `0/${ATTENDANCE_CONFIG.REQUIRED_SAMPLES} samples`,
    status: attendanceState.signedIn ? "SIGNED_IN" : "WAITING",
    lastSignIn: attendanceState.signedInAt ? new Date(attendanceState.signedInAt).toLocaleTimeString() : "--",
  });
  setAttendanceStatus({ active: true, inside: attendanceState.signedIn, text: "Starting attendance GPS tracking..." });

  watchId = navigator.geolocation.watchPosition(
    (position) => { void handlePosition(position); },
    handlePositionError,
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
  );
  updateButton();
}

export function stopAttendanceTracking(): void {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  stopElevationSensor();
  outsideSamples = 0;
  clearOfficeEndTimer();
  resetVerification();
  console.log("[Attendance] tracking stopped");
  setAttendanceStatus({
    active: false,
    inside: attendanceState.signedIn,
    text: attendanceState.signedIn ? "Attendance tracking stopped while signed in." : "Attendance tracking is off.",
  });
  updateButton();
}

export async function signOutAttendanceOnLogout(): Promise<void> {
  if (!activeUser || !attendanceState.signedIn) return;

  setAttendanceStatus({ active: true, inside: true, text: "Signing out attendance..." });

  try {
    const position = lastPosition ?? await getCurrentPositionOnce();
    await saveSignOut(position, "VERIFIED");
    clearOfficeEndTimer();
  } catch (error) {
    console.error("[Attendance] logout sign-out failed:", error);
    showToast("Attendance sign-out failed during logout. Check backend logs.", "error");
    throw error;
  }
}

export function clearAttendanceUser(): void {
  stopAttendanceTracking();
  activeUser = null;
  lastPosition = null;
  previousSample = null;
  clearOfficeEndTimer();
  updateButton();
}

export function bindAttendanceControls(): void {
  updateButton();
  buttonElement()?.addEventListener("click", async () => {
    if (activeUser && attendanceState.signedIn) {
      try {
        setAttendanceStatus({ active: true, inside: true, text: "Signing out attendance..." });
        const position = lastPosition ?? await getCurrentPositionOnce();
        await saveSignOut(position, "VERIFIED");
        stopAttendanceTracking();
      } catch (error) {
        console.error("[Attendance] manual sign-out failed:", error);
        showToast("Attendance sign-out failed. Check backend logs.", "error");
        updateButton();
      }
      return;
    }

    if (watchId === null) {
      if (activeUser) startAttendanceTracking(activeUser.email, activeUser.name);
    } else {
      stopAttendanceTracking();
    }
  });
}

export function onAttendanceAutoSignOut(callback: () => void): void {
  window.addEventListener(AUTO_SIGN_OUT_EVENT, callback);
}
