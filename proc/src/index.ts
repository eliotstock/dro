import * as cp from 'child_process'

// We do not define the command line for the actual dro process here - that's a script in the
// package.json for the dro module next door.
// To test, use unix `sleep` which takes a number of seconds and returns.
// const DRO_PROCESS = 'sleep 5'
const DRO_PROCESS = 'npm run prod'
const DRO_DIR = '../dro'

const BACKOFF_RETRIES_MAX = 7
const BACKOFF_DELAY_BASE_SEC = 6

// How long does the dro process need to run before we consider it a successful run?
const TIMER_SEC = 120

let retries: number
let stopwatchMillis: number

// This use of setTimeout() will work even if we block the Node.js event loop with cp.execSync().
function wait(seconds: number) {
    return new Promise((resolve) => {
        setTimeout(resolve, seconds * 1_000);
    })
}

function startStopwatch() {
    stopwatchMillis = new Date().getTime()
}

function readStopwatch(): number {
    const millis = (new Date().getTime()) - stopwatchMillis

    return millis / 1_000
}

// Do exponential backoff on HTTP error responses from the provider, or indeed anything that can
// kill the dro process.
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
                console.log(`Process died with Javascript Error instance: ${JSON.stringify(e)}`)
            }
            else {
                console.log(`Process died with error: ${JSON.stringify(e)}`)
            }
        }

        const elapsed = readStopwatch()

        if (elapsed > TIMER_SEC) {
            console.log(`Process ran for ${elapsed} seconds: success. Resetting our retry count.`)

            retries = 1
        }
        else {
            console.log(`Process ran for ${elapsed} seconds: failed.`)
        }

        if (retries > BACKOFF_RETRIES_MAX) {
            console.error(`Maximum retries of ${BACKOFF_RETRIES_MAX} exceeded. Fatal.`)
            process.exit(1)
        }

        // Whether the last run suceeded or failed, we still need to retry now.

        // 6^1: delay for 6 seconds
        // 6^2: delay for 36 seconds, etc.
        const delay = Math.pow(BACKOFF_DELAY_BASE_SEC, retries)

        console.log(`Retry #${retries}. Backing off for ${delay} seconds...`)
        await wait(delay)
        console.log(`...done`)
    } while (true)
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
