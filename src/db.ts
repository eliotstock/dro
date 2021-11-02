import sqlite3 from 'sqlite3'
import { Database, open } from 'sqlite'
import { existsSync } from 'fs'

const OUT_DIR = './out'
const SQLITE_DB_FILE = OUT_DIR + '/database.db'

async function openDb () {
    const db: Database = await open({
        filename: SQLITE_DB_FILE,
        driver: sqlite3.Database
    })

    return db
}

// Create the database if it doesn't already exist.
export async function init() {
    if (!existsSync(SQLITE_DB_FILE)) {
        const db: Database = await openDb()

        await db.exec('CREATE TABLE IF NOT EXISTS rerange_event (\
            width INTEGER NOT NULL, \
            datetime TEXT NOT NULL, \
            direction TEXT NOT NULL)')
    }
}

// Pass dates as ISO8601 strings ("YYYY-MM-DD HH:MM:SS.SSS"). Sqlite does not have a DATETIME
// column type.
export async function insertRerangeEvent(width: number, datetimeUtc: string, direction: string) {
    const db: Database = await openDb()

    const result = await db.run('INSERT INTO rerange_event (width, datetime, direction) \
VALUES (?, ?, ?)', width, datetimeUtc, direction)

    console.log(`Row ID: ${result}.rowID`)
}

export async function dumpToCsv() {
    const db: Database = await openDb()

    console.log(`Width, Datetime, Direction`)

    const rowsCount = await db.each('SELECT width, datetime, direction FROM rerange_event ORDER BY datetime', (err, row) => {
        if (err) {
          throw err
        }
    
        console.log(`${row.width}, ${row.datetime}, ${row.direction}`)
      })
}
