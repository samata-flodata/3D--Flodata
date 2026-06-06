import { updateRoomAvailability } from "./rooms";
import { displayAllEventsInCard, refreshBookingPanelIfOpen } from "./ui";
import {
  initBookingEngine,
  setCurrentUser,
  stopPolling,
} from "./booking";
import type { GlobalEvent, UpdateContext } from "./booking";
import { ALLOWED_DOMAIN } from "./config";
import {
  bindAttendanceControls,
  clearAttendanceUser,
  onAttendanceAutoSignOut,
  signOutAttendanceOnLogout,
  startAttendanceTracking,
} from "./attendance";

declare const google: any;
declare const gapi: any;

const DEFAULT_GOOGLE_CLIENT_ID = "953961693663-56gksfsa1l459umnln85uf8l5vet8fev.apps.googleusercontent.com";
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? DEFAULT_GOOGLE_CLIENT_ID;
const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY ?? "";
const REDIRECT_PATH = import.meta.env.VITE_GOOGLE_REDIRECT_PATH ?? "/auth/google/callback";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

let tokenClient: any = null;
let isAllowedDomain = false;
let isSignedIn = false;
let currentAccessToken: string | null = null;
let controlsBound = false;
let setupInProgress: Promise<void> | null = null;
let redirectHandled = false;

const STORAGE_KEY = "cesium_google_auth";
let defaultAvatarHtml = "";

function getGoogleGlobal(): any {
  return (globalThis as any).google;
}

function getGapiGlobal(): any {
  return (globalThis as any).gapi;
}

function getButton(): HTMLElement | null {
  return document.getElementById("userProfile") as HTMLElement | null;
}

function getAvatar(): HTMLElement | null {
  return document.getElementById("userAvatar") as HTMLElement | null;
}

function getUserMenu(): HTMLElement | null {
  return document.getElementById("userMenu") as HTMLElement | null;
}

function closeUserMenu(): void {
  const menu = getUserMenu();
  const button = getButton();
  if (menu) menu.hidden = true;
  button?.classList.remove("menu-open");
}

function toggleUserMenu(): void {
  const menu = getUserMenu();
  const button = getButton();
  if (!menu || !button) return;
  const nextOpen = Boolean(menu.hidden);
  menu.hidden = !nextOpen;
  button.classList.toggle("menu-open", nextOpen);
}

function initialsFromProfile(info: { email?: string; name?: string; given_name?: string; family_name?: string }): string {
  const first = info.given_name?.trim();
  const last = info.family_name?.trim();
  if (first && last) return `${first[0]}${last[0]}`.toUpperCase();

  const nameParts = info.name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (nameParts.length >= 2) return `${nameParts[0][0]}${nameParts[nameParts.length - 1][0]}`.toUpperCase();
  if (nameParts.length === 1) return nameParts[0].slice(0, 2).toUpperCase();

  const emailPrefix = info.email?.split("@")[0] ?? "";
  const emailParts = emailPrefix.split(/[._-]+/).filter(Boolean);
  if (emailParts.length >= 2) return `${emailParts[0][0]}${emailParts[1][0]}`.toUpperCase();
  return emailPrefix.slice(0, 2).toUpperCase() || "U";
}

function showSignedInAvatar(info: { email?: string; name?: string; given_name?: string; family_name?: string }): void {
  const avatar = getAvatar();
  if (!avatar) return;
  avatar.classList.remove("google-avatar");
  avatar.textContent = initialsFromProfile(info);
  avatar.title = info.name || info.email || "Signed in";
}

function showGoogleAvatar(): void {
  const avatar = getAvatar();
  if (!avatar) return;
  avatar.classList.add("google-avatar");
  avatar.innerHTML = defaultAvatarHtml;
  avatar.title = "Sign in with Google";
}

function setButtonState(state: "ready" | "loading" | "signed-in", label?: string): void {
  const btn = getButton();
  if (!btn) return;
  btn.classList.remove("btn-loading", "btn-signed-in");
  btn.title = "";

  if (state === "loading") {
    btn.style.opacity = "0.6";
    btn.style.pointerEvents = "none";
    btn.title = "Signing in…";
    btn.classList.add("btn-loading");
  } else if (state === "signed-in") {
    btn.style.opacity = "1";
    btn.style.pointerEvents = "auto";
    btn.title = label ?? "Signed in. Click to sign out";
    btn.classList.add("btn-signed-in");
  } else {
    btn.style.opacity = "1";
    btn.style.pointerEvents = "auto";
    btn.title = "Click to sign in with Google";
  }
}

async function handleSignOut(): Promise<void> {
  try {
    await signOutAttendanceOnLogout();
  } catch {
    return;
  }

  stopPolling();
  clearAttendanceUser();
  setCurrentUser(null);
  if (currentAccessToken) {
    google.accounts.oauth2.revoke(currentAccessToken, () => {});
    gapi.client.setToken(null);
  }
  isSignedIn = false;
  isAllowedDomain = false;
  currentAccessToken = null;
  localStorage.removeItem(STORAGE_KEY);

  const card = document.getElementById("roomDetailsCard");
  if (card) card.style.display = "none";

  closeUserMenu();
  showGoogleAvatar();
  setButtonState("ready");
}

function waitForGoogleApis(): Promise<void> {
  const waitUntilReady = (isReady: () => boolean, timeoutMs: number): Promise<void> => {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = window.setInterval(() => {
        if (isReady()) {
          window.clearInterval(timer);
          resolve();
        } else if (Date.now() - started > timeoutMs) {
          window.clearInterval(timer);
          reject(new Error("Timed out waiting for Google API"));
        }
      }, 100);
    });
  };

  const loadScript = (id: string, src: string, isReady: () => boolean): Promise<void> => {
    if (isReady()) return Promise.resolve();

    return new Promise((resolve, reject) => {
      document.getElementById(id)?.remove();
      const script = document.createElement("script");
      script.id = id;
      script.src = src;
      script.async = true;
      script.defer = true;
      script.onload = () => {
        waitUntilReady(isReady, 5000).then(resolve).catch(() => {
          reject(new Error(`Loaded ${src}, but API was not available`));
        });
      };
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  };

  const loadScriptWithRetry = async (id: string, src: string, isReady: () => boolean): Promise<void> => {
    if (isReady()) return;
    const existing = document.getElementById(id);
    if (existing) {
      try {
        await waitUntilReady(isReady, 12000);
        return;
      } catch {
        existing.remove();
      }
    }

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await loadScript(id, src, isReady);
        return;
      } catch (error) {
        lastError = error;
        document.getElementById(id)?.remove();
        await new Promise((resolve) => window.setTimeout(resolve, attempt * 750));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Failed to load ${src}`);
  };

  return new Promise(async (resolve, reject) => {
    try {
      await loadScriptWithRetry("google-gsi-client", "https://accounts.google.com/gsi/client", () => Boolean(getGoogleGlobal()?.accounts?.oauth2));
      await loadScriptWithRetry("google-api-client", "https://apis.google.com/js/api.js", () => Boolean(getGapiGlobal()?.load));
    } catch (error) {
      reject(error);
      return;
    }

    const started = Date.now();
    const timer = window.setInterval(() => {
      if (typeof google !== "undefined" && typeof gapi !== "undefined") {
        window.clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 10000) {
        window.clearInterval(timer);
        reject(new Error("Google API scripts did not load"));
      }
    }, 100);
  });
}

function getOAuthRedirectUri(): string {
  return new URL(REDIRECT_PATH, window.location.origin).toString();
}

function startRedirectSignIn(): void {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: getOAuthRedirectUri(),
    response_type: "token",
    scope: SCOPES,
    include_granted_scopes: "true",
    prompt: "consent",
    state: "cesium-google-auth",
  });
  window.location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}

function consumeRedirectToken(): boolean {
  if (redirectHandled || !window.location.hash) return false;

  const hash = new URLSearchParams(window.location.hash.slice(1));
  const accessToken = hash.get("access_token");
  const error = hash.get("error");
  const state = hash.get("state");
  if (state !== "cesium-google-auth" && !accessToken && !error) return false;

  redirectHandled = true;
  history.replaceState(null, document.title, `${window.location.pathname}${window.location.search}`);

  if (accessToken) {
    gapi.client.setToken({ access_token: accessToken });
    void verifyDomainAndLoad(accessToken);
    return true;
  }

  console.warn("Google redirect sign-in failed:", error || "unknown error");
  setButtonState("ready");
  alert(`Google sign-in failed: ${error || "unknown error"}`);
  return true;
}

function bindCalendarControls(button: HTMLElement): void {
  if (controlsBound) return;
  controlsBound = true;

  button.addEventListener("click", async () => {
    if (isSignedIn) {
      toggleUserMenu();
      return;
    }

    setButtonState("loading");
    if (!tokenClient) {
      try {
        await initializeCalendar();
      } catch {
        setButtonState("ready");
        return;
      }
    }

    if (tokenClient) {
      try {
        tokenClient.requestAccessToken({ prompt: "consent" });
      } catch (error) {
        console.warn("Google popup sign-in failed, trying redirect:", error);
        startRedirectSignIn();
      }
    } else {
      setButtonState("ready");
      button.title = "Calendar unavailable. Click to retry";
    }
  });

  document.getElementById("logoutBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    void handleSignOut();
  });
  onAttendanceAutoSignOut(() => {
    void handleSignOut();
  });

  document.addEventListener("click", (event) => {
    if (!button.contains(event.target as Node)) closeUserMenu();
  });
}

function loadGapi(): Promise<void> {
  return new Promise((resolve, reject) => {
    gapi.load("client", async () => {
      try {
        const initOptions: { apiKey?: string; discoveryDocs: string[] } = {
          discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest"],
        };
        if (API_KEY) initOptions.apiKey = API_KEY;
        await gapi.client.init(initOptions);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

function onGlobalUpdate(events: GlobalEvent[], context: UpdateContext): void {
  updateRoomAvailability(events);
  refreshBookingPanelIfOpen(events);
  if (context.isInitialLoad || context.hasNewBookings) {
    displayAllEventsInCard(events, isAllowedDomain);
  }
}

async function verifyDomainAndLoad(accessToken: string): Promise<void> {
  try {
    const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const info = (await response.json()) as { email?: string; name?: string; given_name?: string; family_name?: string };
    const email = info.email ?? "";
    isAllowedDomain = email.toLowerCase().endsWith(`@${ALLOWED_DOMAIN}`);

    if (!isAllowedDomain) {
      alert(`Access restricted to ${ALLOWED_DOMAIN} accounts only.\nSigned in as: ${email}`);
      google.accounts.oauth2.revoke(accessToken, () => {});
      gapi.client.setToken(null);
      setButtonState("ready");
      return;
    }

    isSignedIn = true;
    currentAccessToken = accessToken;
    setCurrentUser(email);
    startAttendanceTracking(email, info.name ?? "");
    showSignedInAvatar(info);
    setButtonState("signed-in", `✓ ${email.split("@")[0]}`);

    // Persist token for 1 hour (default Google token life)
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        token: accessToken,
        email: email,
        expiresAt: Date.now() + 3500 * 1000,
      })
    );
  } catch (error) {
    console.error("Failed to verify user domain:", error);
    localStorage.removeItem(STORAGE_KEY);
    setButtonState("ready");
    return;
  }

  await initBookingEngine(onGlobalUpdate);
}

function initGoogleAuth(): void {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: (tokenResponse: { access_token?: string; error?: string }) => {
      if (!tokenResponse.access_token) {
        setButtonState("ready");
        return;
      }
      gapi.client.setToken({ access_token: tokenResponse.access_token });
      void verifyDomainAndLoad(tokenResponse.access_token);
    },
    error_callback: (err: { type: string }) => {
      console.warn("Google auth cancelled:", err.type);
      setButtonState("ready");
    },
  });
}

export async function initializeCalendar(): Promise<void> {
  const button = document.getElementById("userProfile") as HTMLElement | null;
  if (!button) return;
  defaultAvatarHtml = getAvatar()?.innerHTML ?? "";
  bindCalendarControls(button);
  bindAttendanceControls();

  if (!CLIENT_ID) {
    button.style.pointerEvents = "auto";
    button.style.opacity = "0.5";
    button.title = "Set VITE_GOOGLE_CLIENT_ID to enable Calendar";
    return;
  }

  try {
    setupInProgress ??= (async () => {
      await waitForGoogleApis();
      await loadGapi();
      initGoogleAuth();
    })();
    await setupInProgress;
    setButtonState("ready");

    if (consumeRedirectToken()) return;

    // Check for persisted session
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const { token, expiresAt } = JSON.parse(stored);
        if (token && expiresAt > Date.now()) {
          console.log("[Auth] Restoring persisted session...");
          gapi.client.setToken({ access_token: token });
          void verifyDomainAndLoad(token);
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch (e) {
        localStorage.removeItem(STORAGE_KEY);
      }
    }

  } catch (error) {
    setupInProgress = null;
    console.error("Google Calendar setup failed:", error);
    button.style.pointerEvents = "auto";
    button.style.opacity = "0.5";
    button.removeAttribute("aria-disabled");
    button.title = "Calendar unavailable. Click to retry";
  }
}
