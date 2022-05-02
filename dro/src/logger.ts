import { createLogger, transports, format, config } from 'winston'

// Define the log format
const { splat, combine, timestamp, printf, colorize, json, metadata } = format;
const myFormat = printf( ({ level, message, timestamp }) => {
    let msg = `${timestamp} [${level}] : ${message} `  
  
    if(metadata) {
        msg += JSON.stringify(metadata)
    }

    return msg
});

// Create a custom logger
export const log = createLogger({
    levels: config.syslog.levels,
    format: combine(
        colorize(),
        splat(),
        timestamp(),
        myFormat
    ),
    defaultMeta: { service: 'dro' },
    transports: [
        new transports.Console({ level: 'info' }),
    ],
    exceptionHandlers: [
        new transports.Console({ level: 'info' }),
    ]
});

log.info('Logger initialized');