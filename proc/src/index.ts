import * as cp from 'child_process'
import moment, { Duration } from 'moment'

// We do not define the command line for the actual dro process here - that's a script in the
// package.json for the dro module next door.
// To test, use unix `sleep` which takes a number of seconds and returns.
// const DRO_PROCESS = 'sleep 5'
const DRO_PROCESS = 'npm run prod'
const DRO_DIR = '../dro'

const BACKOFF_DURATIONS = [
    moment.duration(15, 'seconds'), // ie. next block, at least on L1
    moment.duration(1, 'minute'),
    moment.duration(2, 'minutes'),
    moment.duration(5, 'minutes'),
    moment.duration(10, 'minutes'),
    moment.duration(30, 'minutes'),
    moment.duration(1, 'hour'),
    moment.duration(2, 'hours'),
    moment.duration(4, 'hours'),
]

// How long does the dro process need to run before we consider it a successful run?
const SUCCESS_DURATION = moment.duration(2, 'minutes')

let retries: number
let stopwatchMillis: number

// This use of setTimeout() will work even if we block the Node.js event loop with cp.execSync().
function wait(delay: moment.Duration) {
    return new Promise((resolve) => {
        const millis = delay.asMilliseconds()
        setTimeout(resolve, millis);
    })
}

function startStopwatch() {
    stopwatchMillis = new Date().getTime()
}

function readStopwatch(): moment.Duration {
    const millis = (new Date().getTime()) - stopwatchMillis

    return moment.duration(millis, 'milliseconds')
}

// Do some backoff on HTTP error responses from the provider, or indeed anything that can kill the
// dro process.
async function main() {
    retries = 0

    do {
        retries++

        try {
            // After some time of the process running successfully, reset our retry count.
            startStopwatch()

            console.log(`Starting new dro process`)

            // execSync() will block here. The Node.js event loop will NOT be allowed to run.
            // This is very bad form for a Javascript app, but in this case we have no other
            // work to be done.
            cp.execSync(DRO_PROCESS, {'cwd': DRO_DIR})
        }
        catch (e: unknown) {
            if (e instanceof Error) {
                // This error is supposed to have a code property according to the Node.js docs,
                // but doesn't:
                // interface Error {
                //   name: string;
                //   message: string;
                //   stack?: string;
                // }
                console.log(`Process died with error message: ${e.message}`)
            }
            else {
                console.log(`Process died`)
            }
        }

        const elapsed = readStopwatch()

        // Whether the last run suceeded or failed, we still need to retry now.
        if (elapsed > SUCCESS_DURATION) {
            console.log(`Process ran for ${elapsed.humanize()}: success. Resetting our retry count.`)

            retries = 1
        }
        else {
            console.log(`Process ran for ${elapsed.humanize()}: failed`)
        }

        // We never give up completely, we just keep retrying at the longest duration.
        const cappedRetries = Math.min(retries, BACKOFF_DURATIONS.length)

        const delay = BACKOFF_DURATIONS[cappedRetries - 1]

        console.log(`Retry #${retries}. Backing off for ${delay.humanize()}...`)
        await wait(delay)
        console.log(`...done`)
    } while (true)
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
