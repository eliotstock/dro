import * as cp from 'child_process'

const BACKOFF_RETRIES_MAX = 7
const BACKOFF_DELAY_BASE_SEC = 6
const TIMER_SEC = 120

let retries
let timeoutId: NodeJS.Timeout

function sleep(seconds: number) {
    return new Promise((resolve) => {
        setTimeout(resolve, seconds * 1_000);
    })
}

// Once the dro process has been running for a while, our back-off has been successful.
function onProcessTimerElapsed() {
    console.log(`dro process still running after ${TIMER_SEC} sec. Resetting retry count.`)

    retries = 0
}

// Do something some time after the dro process has been running.
function restartProcessTimer() {
    console.log(`Clearing any previous process timer`)

    // Passing an invalid ID to clearTimeout() silently does nothing; no exception is thrown.
    clearTimeout(timeoutId)

    console.log(`Starting new process timer`)

    timeoutId = setTimeout(onProcessTimerElapsed, TIMER_SEC * 1_000)

    console.log(`Done`)
}

// Do exponential backoff on HTTP error responses from the provider, or indeed anything that can
// kill the dro process.
async function main() {
    retries = 0

    do {
        retries++

        try {
            // After some time of the process running successfully, reset our retry count.
            restartProcessTimer()

            console.log(`Starting new dro process`)

            // We do not define the command line for the actual dro process here - that's a script
            // in the package.json for the dro module next door.
            // execSync() will block while the child process is running and return a string or
            // buffer of the stdout when it exits, which we don't need.
            cp.execSync('npm run prod', {'cwd': '../dro'})
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
                console.log(`dro process died with Javascript Error instance: ${JSON.stringify(e)}`)
            }
            else {
                console.log(`dro process died with error: ${JSON.stringify(e)}`)
            }
        }

        // Note that execution will also reach here if the dro process exits normally (with code 0)
        // but it never does. Its non-error behaviour is to run forever, at least with the command
        // line above.

        if (retries > BACKOFF_RETRIES_MAX) {
            console.error(`Maximum retries of ${BACKOFF_RETRIES_MAX} exceeded. Fatal.`)
            process.exit(1)
        }

        // 6^1: delay for 6 seconds
        // 6^2: delay for 36 seconds, etc.
        const delay = Math.pow(BACKOFF_DELAY_BASE_SEC, retries)

        console.log(`Retry #${retries}. Backing off for ${delay} seconds...`)
        await sleep(delay)
        console.log(`...done`)
    } while (true)
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
