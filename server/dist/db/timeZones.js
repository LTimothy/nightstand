// UTC first, then west to east by standard offset.
export const TIME_ZONES = [
    'UTC', // Coordinated Universal Time
    'Pacific/Honolulu', // Hawaii
    'America/Anchorage', // Alaska
    'America/Los_Angeles', // Pacific Time (US & Canada)
    'America/Vancouver', // British Columbia
    'America/Phoenix', // Arizona
    'America/Denver', // Mountain Time (US & Canada)
    'America/Edmonton', // Alberta and Saskatchewan
    'America/Mexico_City', // Mexico
    'America/Chicago', // Central Time (US & Canada)
    'America/Bogota', // Colombia
    'America/New_York', // Eastern Time (US & Canada)
    'America/Puerto_Rico', // Puerto Rico
    'America/Halifax', // Atlantic Time (Canada)
    'America/Santiago', // Chile
    'America/St_Johns', // Newfoundland
    'America/Sao_Paulo', // Brazil
    'Atlantic/Reykjavik', // Iceland
    'Europe/London', // UK
    'Europe/Berlin', // Central European Time
    'Africa/Lagos', // West Africa Time
    'Europe/Helsinki', // Eastern European Time
    'Africa/Cairo', // Egypt
    'Africa/Johannesburg', // South Africa Time
    'Asia/Jerusalem', // Israel
    'Europe/Moscow', // Moscow Time
    'Asia/Dubai', // Gulf Standard Time
    'Asia/Karachi', // Pakistan
    'Asia/Kolkata', // India Standard Time
    'Asia/Bangkok', // Indochina Time
    'Asia/Shanghai', // China Standard Time
    'Australia/Perth', // Western Australia
    'Asia/Tokyo', // Japan Standard Time
    'Australia/Darwin', // Northern Territory
    'Australia/Adelaide', // South Australia
    'Australia/Brisbane', // Queensland
    'Australia/Sydney', // New South Wales
    'Pacific/Auckland', // New Zealand
];
// node-schedule reads Node's built-in zone data, which can predate a zone going
// to one offset all year; moment-timezone already has these.
const FIXED_OFFSETS = { 'America/Vancouver': 'UTC-7', 'America/Edmonton': 'UTC-6' };
export const scheduleZone = (zone) => FIXED_OFFSETS[zone] ?? zone;
//# sourceMappingURL=timeZones.js.map