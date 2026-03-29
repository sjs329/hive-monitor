// ─────────────────────────────────────────────────────────────────────────────
// Shared config — used by both overview and detail pages
// ─────────────────────────────────────────────────────────────────────────────

// Canonical frontend config for both overview and detail pages.
// DATA_SOURCE can be "supabase" (default) or "appscript".
const DATA_SOURCE = "supabase";

// Apps Script web app URL (read + config API)
const API_URL = "https://script.google.com/macros/s/AKfycbztKeecB0nywOhAiUg0raMUyaW7S9CLonxD29ffsRSBea-hPz6Fh6r2kRVEBOIEtKO3GA/exec";
const CONFIG_API_URL = API_URL;

// Supabase dashboard-read settings
const SUPABASE_URL = "https://wivbegbxspqfypuilwzj.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpdmJlZ2J4c3BxZnlwdWlsd3pqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzOTk5MzQsImV4cCI6MjA4OTk3NTkzNH0.aEy1eYSKP3jqmLy-8FXzTY9bCHOgB_-we4mCVgLEWg0";

const FETCH_LIMIT = 2000;
const AUTO_REFRESH_MS = 60000;

const HIVES_CONFIG = [
  {
    id: "pooh",
    label: "Pooh",
    icon: "icons/pooh.svg",
    device_id: "1e432d9f-0798-4578-9da1-31471c5ba848",
    active: true,
    location: "",
  },
  {
    id: "piglet",
    label: "Piglet",
    icon: "icons/piglet.svg",
    device_id: null,
    active: false,
    location: "Coming soon",
  },
  {
    id: "eeyore",
    label: "Eeyore",
    icon: "icons/eeyore.svg",
    device_id: null,
    active: false,
    location: "Coming soon",
  },
];

Object.assign(window, {
  DATA_SOURCE,
  API_URL,
  CONFIG_API_URL,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  FETCH_LIMIT,
  AUTO_REFRESH_MS,
  HIVES_CONFIG,
});
