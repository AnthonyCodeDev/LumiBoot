export function padCount(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatClock(date: Date, locale = 'fr-BE'): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date);
}
