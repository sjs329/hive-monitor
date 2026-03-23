// ─────────────────────────────────────────────────────────────────────────────
// Shared config — used by both overview and detail pages
// ─────────────────────────────────────────────────────────────────────────────

// Replace with your Apps Script /exec URL (no ?key= needed for GET)
const API_URL = "https://script.google.com/macros/s/AKfycbztKeecB0nywOhAiUg0raMUyaW7S9CLonxD29ffsRSBea-hPz6Fh6r2kRVEBOIEtKO3GA/exec";
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
