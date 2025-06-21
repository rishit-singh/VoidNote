enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

interface LoggerConfig {
  isProduction: boolean;
  debugEnabled: boolean;
  logLevel: LogLevel;
}

class Logger {
  private config: LoggerConfig;

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = {
      isProduction: process.env.NODE_ENV === 'production',
      debugEnabled: process.env.NODE_ENV !== 'production',
      logLevel: LogLevel.INFO,
      ...config,
    };
  }

  private formatTimestamp(): string {
    const now = new Date();
    return now.toISOString();
  }

  private formatMessage(level: string, message: string, ...args: any[]): string {
    const timestamp = this.formatTimestamp();
    const formattedArgs = args.length > 0 ? ` ${args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ')}` : '';
    
    return `[${timestamp}] [${level}] ${message}${formattedArgs}`;
  }

  private shouldLog(level: LogLevel): boolean {
    if (this.config.isProduction && level < LogLevel.WARN) {
      return false;
    }
    
    if (!this.config.debugEnabled && level === LogLevel.DEBUG) {
      return false;
    }
    
    return level >= this.config.logLevel;
  }

  debug(message: string, ...args: any[]): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      console.debug(this.formatMessage('DEBUG', message, ...args));
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.shouldLog(LogLevel.INFO)) {
      console.info(this.formatMessage('INFO', message, ...args));
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.shouldLog(LogLevel.WARN)) {
      console.warn(this.formatMessage('WARN', message, ...args));
    }
  }

  error(message: string, ...args: any[]): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      console.error(this.formatMessage('ERROR', message, ...args));
    }
  }

  setConfig(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): LoggerConfig {
    return { ...this.config };
  }
}

// Create default logger instance
const logger = new Logger();

// Export both the Logger class and default instance
export { Logger, LogLevel, type LoggerConfig };
export default logger; 