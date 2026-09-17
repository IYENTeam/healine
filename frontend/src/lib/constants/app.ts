export const APP_NAME = 'Healine';
export const APP_DESCRIPTION = 'Your wearable data, in one place.';
export const REPOSITORY_URL = 'https://github.com/IYENTeam/healine';
export const DOCUMENTATION_URL = `${REPOSITORY_URL}/tree/main/docs`;

export function getCopyrightText() {
  return `© ${new Date().getFullYear()} ${APP_NAME}`;
}
