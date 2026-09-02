type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

const LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export interface Logger {
  debug: (msg: string, fields?: Record<string, unknown>) => void;
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
  fatal: (msg: string, fields?: Record<string, unknown>) => void;
}

export function createLogger(module: string): Logger {
  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    const entry = JSON.stringify({
      ...fields,
      level: LEVEL_VALUES[level],
      time: new Date().toISOString(),
      name: module,
      msg,
    });
    if (level === "error" || level === "fatal") {
      console.error(entry);
    } else if (level === "warn") {
      console.warn(entry);
    } else {
      console.log(entry);
    }
  };

  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    fatal: (msg, fields) => write("fatal", msg, fields),
  };
}
