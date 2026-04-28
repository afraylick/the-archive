const FILENAME_RECORDED_DATE_PATTERN = /^(2\d{5})(?!\d)/;

export const getRecordedDateFromFilename = (filename: string) => {
  const match = filename.match(FILENAME_RECORDED_DATE_PATTERN);
  if (!match) return null;

  const value = match[1];
  const year = 2000 + Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  const date = new Date(Date.UTC(year, month - 1, day, 12));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return {
    year,
    createdAt: date.toISOString(),
  };
};
