import sqlite3 from 'sqlite3'
import { Database, open } from 'sqlite'
import moment from 'moment'

const OUT_DIR = './out'
const SQLITE_DB_FILE = OUT_DIR + '/database.db'

async function openDb () {
    const db: Database = await open({
        filename: SQLITE_DB_FILE,
        driver: sqlite3.Database
    })

    return db
}

const sum = (numbers: number[]) => numbers.reduce((total, aNumber) => total + aNumber, 0)
const mean = (numbers: number[]) => sum(numbers) / numbers.length

// Create the database if it doesn't already exist.
export async function init() {
    const db: Database = await openDb()

    // sqlite command line to query this:
    // sqlite3 ./out/database.db "SELECT datetime, direction FROM rerange_event WHERE width = '120' AND datetime < '2021-12-01T00:00:00.000Z'"
    await db.exec('CREATE TABLE IF NOT EXISTS rerange_event (\
        width INTEGER NOT NULL, \
        datetime TEXT NOT NULL, \
        direction TEXT NOT NULL)')

    // We are only ever in one position at a time for now, and certainly only ever one per
    // range width.
    await db.exec('CREATE TABLE IF NOT EXISTS position (\
        width INTEGER PRIMARY KEY, \
        datetime TEXT NOT NULL, \
        token_id INTEGER NULL)')
}

// Pass dates as ISO8601 strings ("YYYY-MM-DD HH:MM:SS.SSS"). Sqlite does not have a DATETIME
// column type.
export async function insertOrReplacePosition(width: number, datetimeUtc: string, tokenId: number) {
    const db: Database = await openDb()

    const result = await db.run('INSERT OR REPLACE INTO position (width, datetime, token_id) \
VALUES (?, ?, ?)', width, datetimeUtc, tokenId)

    // console.log(`Row ID: ${result}.rowID`)
}

export async function deletePosition(width: number) {
    const db: Database = await openDb()

    const result = await db.run('DELETE FROM position WHERE width = ?', width)

    // console.log(`Result:`)
    // console.dir(result)
}

export async function getTokenIdForOpenPosition(): Promise<number | undefined> {
    const db: Database = await openDb()

    const row = await db.get('SELECT token_id FROM position ORDER BY datetime DESC LIMIT 1', [])

    if (row === undefined) return undefined

    return row.token_id
}

// Pass dates as ISO8601 strings ("YYYY-MM-DD HH:MM:SS.SSS"). Sqlite does not have a DATETIME
// column type.
export async function insertRerangeEvent(width: number, datetimeUtc: string, direction: string) {
    const db: Database = await openDb()

    const result = await db.run('INSERT INTO rerange_event (width, datetime, direction) \
VALUES (?, ?, ?)', width, datetimeUtc, direction)
}

export async function dumpTokenIds() {
    const db: Database = await openDb()

    console.log(`\nWidth, Token ID`)

    const rowsCount = await db.each('SELECT width, token_id FROM position ORDER BY width', (err, row) => {
        if (err) {
          throw err
        }
    
        console.log(`${row.width}, ${row.token_id}`)
      })
}

export async function dumpRerangeEvents() {
    const db: Database = await openDb()

    console.log(`\nWidth, Datetime, Direction`)

    const rowsCount = await db.each('SELECT width, datetime, direction FROM rerange_event ORDER BY datetime', (err, row) => {
        if (err) {
          throw err
        }
    
        console.log(`${row.width}, ${row.datetime}, ${row.direction}`)
      })
}

export async function meanTimeToReranging(width: number): Promise<string> {
    const db: Database = await openDb()

    let previousRerange: string
    const timesToRerangingMillis: number[] = []

    const rowsCount = await db.each('SELECT datetime FROM rerange_event WHERE width = ? ORDER BY datetime', width, (err, row) => {
        if (err) {
          throw err
        }

        if (previousRerange) {
            const a = moment(previousRerange)
            const b = moment(row.datetime)
            const timeToRerangingMillis = b.diff(a)
            const humanized = moment.duration(timeToRerangingMillis, 'milliseconds').humanize()

            // console.log(`Time to reranging: ${humanized}`)

            timesToRerangingMillis.push(timeToRerangingMillis)
        }

        previousRerange = row.datetime
    })

    if (rowsCount == 0) return 'No re-ranges'

    const m = mean(timesToRerangingMillis)
    const d = moment.duration(m, 'milliseconds')

    return `${d.humanize()} (${(m / 1_000 / 60).toFixed(0)} minutes, from ${rowsCount} values)`
}
