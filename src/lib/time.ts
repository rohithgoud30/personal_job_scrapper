const EASTERN_TIME_ZONE = 'America/New_York';

export interface EasternDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const easternFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: EASTERN_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

const easternTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: EASTERN_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true
});

export function getEasternDateParts(date = new Date()): EasternDateParts {
  const parts = easternFormatter.formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second)
  };
}

export function getEasternDateLabel(date = new Date()): string {
  const parts = getEasternDateParts(date);
  return `${String(parts.month).padStart(2, '0')}/${String(parts.day).padStart(2, '0')}/${parts.year}`;
}

export function getEasternTimeLabel(date = new Date()): string {
  const formatted = easternTimeFormatter.format(date);
  return `${formatted} ET`;
}
