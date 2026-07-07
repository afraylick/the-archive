type FilenameDateCandidate = {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
};

export const getRecordedDateFromFilename = (filename: string) => {
  const candidate = getFilenameDateCandidate(filename);
  if (!candidate) return null;

  const { year, month, day } = candidate;
  const hour = candidate.hour ?? 12;
  const minute = candidate.minute ?? 0;
  const second = candidate.second ?? 0;
  const date = new Date(year, month - 1, day, hour, minute, second);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return null;
  }

  return {
    year,
    createdAt: date.toISOString(),
  };
};

const parseTwoDigitYear = (value: string) => {
  const year = Number(value);
  return year >= 70 ? 1900 + year : 2000 + year;
};

const getFilenameDateCandidate = (filename: string): FilenameDateCandidate | null => {
  const yearMonthDayWithTime = filename.match(/(?:^|[ _-])([12]\d{3})([01]\d)([0-3]\d)[ _-]?([0-2]\d)([0-5]\d)([0-5]\d)(?=$|[ ._-])/);
  if (yearMonthDayWithTime) {
    return {
      year: Number(yearMonthDayWithTime[1]),
      month: Number(yearMonthDayWithTime[2]),
      day: Number(yearMonthDayWithTime[3]),
      hour: Number(yearMonthDayWithTime[4]),
      minute: Number(yearMonthDayWithTime[5]),
      second: Number(yearMonthDayWithTime[6]),
    };
  }

  const yearMonthDay = filename.match(/(?:^|[ _-])([12]\d{3})([01]\d)([0-3]\d)(?=$|[ ._-])/);
  if (yearMonthDay) {
    return {
      year: Number(yearMonthDay[1]),
      month: Number(yearMonthDay[2]),
      day: Number(yearMonthDay[3]),
    };
  }

  const monthDayYear = filename.match(/(?:^|[ _-])([01]\d)([0-3]\d)(\d{2})(?=$|[ ._-])/);
  if (monthDayYear) {
    return {
      year: parseTwoDigitYear(monthDayYear[3]),
      month: Number(monthDayYear[1]),
      day: Number(monthDayYear[2]),
    };
  }

  return null;
};
