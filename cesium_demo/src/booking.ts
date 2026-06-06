import { POLL_INTERVAL_MS, CACHE_TTL_MS, ROOM_CALENDARS } from "./config";

declare const gapi: any;

// ── Types ─────────────────────────────────────────────────────────
export type GlobalEvent = {
  id: string;
  room: string;
  title: string;
  start: Date;
  end: Date;
  organizer: string;
  calendarId: string;
};

export type ToastType = "info" | "success" | "error";

// ── Current user ──────────────────────────────────────────────────
export let currentUserEmail: string | null = null;

export function setCurrentUser(email: string | null): void {
  currentUserEmail = email;
}

// ── Room name matching ────────────────────────────────────────────
export function matchRoomName(raw: string): string | null {
  const n = raw.toLowerCase();
  if (n.includes("dojo")) return "Dojo";
  if (n.includes("eureka")) return "Eureka";
  if (n.includes("manthan")) return "Manthan";
  if (n.includes("meeting room") || (n.includes("meeting") && !n.includes("eureka"))) return "Meeting Room";
  if (n.includes("conference room") || n.includes("conference")) return "Conference Room";
  return null;
}

// ── Cache ─────────────────────────────────────────────────────────
let cache: { events: GlobalEvent[]; ts: number } | null = null;

export function invalidateCache(): void {
  cache = null;
}

// ── Fetch global events ───────────────────────────────────────────
/**
 * Always fetches from ROOM_CALENDARS (shared room calendars).
 * Never reads from "primary". All users see the same data.
 */
export async function fetchGlobalEvents(force = false): Promise<GlobalEvent[]> {
  if (!force && cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return cache.events;
  }

  const now = new Date();
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const params = {
    timeMin: now.toISOString(),
    timeMax: endOfDay.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 200,
  };

  // Fetch all room calendars in parallel
  const entries = Object.entries(ROOM_CALENDARS); // [roomName, calendarId][]
  const results = await Promise.allSettled(
    entries.map(([, calId]) =>
      gapi.client.calendar.events.list({ calendarId: calId, ...params })
    )
  );

  let rawEvents: GlobalEvent[] = [];

  results.forEach((result, idx) => {
    const [roomName, calId] = entries[idx];
    if (result.status !== "fulfilled") {
      console.warn(
        `[Booking] Failed to fetch calendar for ${roomName} (${calId}):`,
        (result as PromiseRejectedResult).reason
      );
      return;
    }
    const items: any[] = result.value.result.items ?? [];
    console.log(
      `[Booking] Fetched ${items.length} event(s) from "${roomName}" calendar (${calId})`
    );
    for (const item of items) {
      rawEvents.push(normalizeRawEvent(item, roomName, calId));
    }
  });

  // Deduplicate by event ID
  const seen = new Set<string>();
  rawEvents = rawEvents.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  cache = { events: rawEvents, ts: Date.now() };
  return rawEvents;
}

function normalizeRawEvent(raw: any, room: string, calendarId: string): GlobalEvent {
  return {
    id: raw.id ?? `${room}-${Date.now()}`,
    room,
    title: raw.summary ?? "Meeting",
    start: new Date(raw.start?.dateTime ?? raw.start?.date ?? ""),
    end: new Date(raw.end?.dateTime ?? raw.end?.date ?? ""),
    organizer:
      raw.organizer?.email?.split("@")[0] ??
      raw.creator?.email?.split("@")[0] ??
      "Unknown",
    calendarId,
  };
}

// ── Conflict detection ────────────────────────────────────────────
export function checkConflict(
  room: string,
  start: Date,
  end: Date,
  events: GlobalEvent[]
): GlobalEvent | null {
  return (
    events.find((e) => e.room === room && !(end <= e.start || start >= e.end)) ?? null
  );
}

// ── Create booking ────────────────────────────────────────────────
/**
 * Inserts the event into the user's PRIMARY calendar with the room as an attendee (Method B).
 * This avoids 403 Forbidden errors as users don't need write access to room calendars.
 *
 * Google automatically handles the invitation and updates the room's calendar.
 * We then check if the room declined the invitation to detect double-bookings.
 */
export async function createBooking(
  roomName: string,
  start: Date,
  end: Date,
  _currentEvents: GlobalEvent[] // kept for API compatibility; we always re-fetch
): Promise<{ success: boolean; error?: string }> {
  if (!currentUserEmail) {
    return { success: false, error: "Not signed in" };
  }

  const roomCalId = ROOM_CALENDARS[roomName];
  if (!roomCalId) {
    return {
      success: false,
      error: `No shared calendar configured for "${roomName}"`,
    };
  }

  // ── Fresh conflict check ──────────────────────────────────────
  let freshEvents: GlobalEvent[];
  try {
    freshEvents = await fetchGlobalEvents(true);
  } catch (err) {
    console.warn("[Booking] Fresh fetch failed before booking; using cached events.", err);
    freshEvents = cache?.events ?? [];
  }

  const conflict = checkConflict(roomName, start, end, freshEvents);
  if (conflict) {
    const t = conflict.start.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    return {
      success: false,
      error: `${roomName} already booked at ${t} by ${conflict.organizer}`,
    };
  }

  // ── Insert into user's primary calendar with room as attendee ─
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  console.log(`[Booking] Creating event in primary calendar with room attendee: ${roomCalId} (${roomName})`);

  try {
    const response = await gapi.client.calendar.events.insert({
      calendarId: "primary",
      resource: {
        summary: `${roomName} – Meeting`,
        location: roomName,
        start: { dateTime: start.toISOString(), timeZone: tz },
        end: { dateTime: end.toISOString(), timeZone: tz },
        description: `Booked via Cesium Building Demo by ${currentUserEmail}`,
        attendees: [{ email: roomCalId, resource: true }],
      },
    });

    const eventId = response.result.id;
    console.log(`[Booking] ✓ Event created in primary calendar: ${eventId}. Waiting for room response...`);

    // Give Google a moment to process the room's auto-accept/decline
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const checkResponse = await gapi.client.calendar.events.get({
      calendarId: "primary",
      eventId: eventId,
    });

    const attendees = checkResponse.result.attendees ?? [];
    const roomAttendee = attendees.find((a: any) => a.email === roomCalId);

    if (roomAttendee?.responseStatus === "declined") {
      console.warn(`[Booking] ✗ ${roomName} declined the invitation. Deleting event...`);
      await gapi.client.calendar.events.delete({
        calendarId: "primary",
        eventId: eventId,
      });
      return {
        success: false,
        error: `${roomName} is already booked for this time.`,
      };
    }

    console.log(`[Booking] ✓ ${roomName} accepted/pending booking.`);
    invalidateCache();
    void forceRefreshBookings();
    return { success: true };
  } catch (err: any) {
    const msg: string =
      err?.result?.error?.message ?? err?.message ?? "Booking failed";
    console.error(`[Booking] ✗ Failed to create booking:`, err);
    return { success: false, error: msg };
  }
}

// ── Cancel booking ────────────────────────────────────────────────
export async function cancelBooking(eventId: string): Promise<{ success: boolean; error?: string }> {
  if (!currentUserEmail) {
    return { success: false, error: "Not signed in" };
  }

  try {
    console.log(`[Booking] Cancelling event ${eventId} in primary calendar...`);
    await gapi.client.calendar.events.delete({
      calendarId: "primary",
      eventId: eventId,
    });
    console.log(`[Booking] ✓ Event cancelled.`);
    invalidateCache();
    void forceRefreshBookings();
    return { success: true };
  } catch (err: any) {
    const msg: string = err?.result?.error?.message ?? err?.message ?? "Cancellation failed";
    console.error(`[Booking] ✗ Failed to cancel booking:`, err);
    return { success: false, error: msg };
  }
}

// ── Polling ───────────────────────────────────────────────────────
let previousEvents: GlobalEvent[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let debounceActive = false;

export type UpdateContext = {
  isInitialLoad: boolean;
  hasNewBookings: boolean;
};

export type UpdateCallback = (events: GlobalEvent[], context: UpdateContext) => void;

function detectChanges(prev: GlobalEvent[], next: GlobalEvent[]): boolean {
  const prevIds = new Set(prev.map((e) => e.id));
  const nextIds = new Set(next.map((e) => e.id));
  let hasNewBookings = false;

  for (const event of next) {
    if (!prevIds.has(event.id)) {
      hasNewBookings = true;
      const t = event.start.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      showToast(`${event.room} booked by ${event.organizer} at ${t}`, "info");
    }
  }
  for (const event of prev) {
    if (!nextIds.has(event.id)) {
      showToast(`${event.room} is now available`, "success");
    }
  }

  return hasNewBookings;
}

let activeOnUpdate: UpdateCallback | null = null;
let isInitialLoad = true;

export const forceRefreshBookings = async (): Promise<void> => {
  if (debounceActive || !activeOnUpdate) return;
  debounceActive = true;
  setTimeout(() => { debounceActive = false; }, 2000);

  try {
    const events = await fetchGlobalEvents(true);
    const hasNewBookings =
      !isInitialLoad && previousEvents.length > 0
        ? detectChanges(previousEvents, events)
        : false;
    previousEvents = events;
    activeOnUpdate(events, { isInitialLoad, hasNewBookings });
    isInitialLoad = false;
  } catch {
    /* network blip – keep polling */
  }
};

export function startPolling(onUpdate: UpdateCallback): void {
  stopPolling();
  activeOnUpdate = onUpdate;
  isInitialLoad = true;
  void forceRefreshBookings();
  pollTimer = setInterval(() => void forceRefreshBookings(), POLL_INTERVAL_MS);
}

export function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function getCurrentEvents(): GlobalEvent[] {
  return previousEvents;
}

// ── Toast ─────────────────────────────────────────────────────────
export function showToast(
  message: string,
  type: ToastType = "info",
  duration = 4500
): void {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add("toast-visible"));
  });

  setTimeout(() => {
    toast.classList.remove("toast-visible");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
  }, duration);
}

// ── Init ──────────────────────────────────────────────────────────
/**
 * Starts polling immediately. No calendar discovery needed —
 * ROOM_CALENDARS is the single source of truth.
 */
export async function initBookingEngine(onUpdate: UpdateCallback): Promise<void> {
  startPolling(onUpdate);
}
