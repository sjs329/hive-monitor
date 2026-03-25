// ─────────────────────────────────────────────────────────────────────────────
// Shared config — used by both overview and detail pages
// ─────────────────────────────────────────────────────────────────────────────

// Supabase test config (read-only path for cloned pages)
const SUPABASE_URL = "https://wivbegbxspqfypuilwzj.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpdmJlZ2J4c3BxZnlwdWlsd3pqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzOTk5MzQsImV4cCI6MjA4OTk3NTkzNH0.aEy1eYSKP3jqmLy-8FXzTY9bCHOgB_-we4mCVgLEWg0"; // Set your anon/public key before testing.
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
