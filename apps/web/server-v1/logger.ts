type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

const LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

interface Logger {
  debug: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  fatal: (msg: string) => void;
}

export function createLogger(module: string): Logger {
  const write = (level: LogLevel, msg: string) => {
    const entry = JSON.stringify({
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
    debug: (msg: string) => write("debug", msg),
    info: (msg: string) => write("info", msg),
    warn: (msg: string) => write("warn", msg),
    error: (msg: string) => write("error", msg),
    fatal: (msg: string) => write("fatal", msg),
  };
}
