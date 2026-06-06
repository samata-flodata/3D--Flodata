/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CESIUM_ION_TOKEN?: string;
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  readonly VITE_GOOGLE_API_KEY?: string;
  readonly VITE_GOOGLE_REDIRECT_PATH?: string;
  readonly VITE_ATTENDANCE_API_BASE_URL?: string;
  readonly VITE_ATTENDANCE_BUILDING_LAT?: string;
  readonly VITE_ATTENDANCE_BUILDING_LON?: string;
  readonly VITE_ATTENDANCE_ENTER_RADIUS_METERS?: string;
  readonly VITE_ATTENDANCE_EXIT_RADIUS_METERS?: string;
  readonly VITE_ATTENDANCE_MAX_ACCURACY_METERS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
