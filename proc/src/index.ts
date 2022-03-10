import * as cp from 'child_process'

// We do not define the command line for the actual dro process here - that's a script in the
// package.json for the dro module next door.
// const DRO_PROCESS = 'npm run prod'
const DRO_PROCESS = 'echo "I am the process" && sleep 5'
const DRO_DIR = '../dro'

const BACKOFF_RETRIES_MAX = 7
const BACKOFF_DELAY_BASE_SEC = 6
const TIMER_SEC = 30

let retries: number
let timeoutId: NodeJS.Timeout
let running: boolean

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

// Note that execution will also reach here if the dro process exits normally (with code 0) but it
// never does. Its non-error behaviour is to run forever, at least with the command line above.
async function onProcessEnded(error: cp.ExecException | null, stdout: string | Buffer, stderr: string | Buffer) {
    if (error) {
        console.log(`dro process died with status ${error.code}, stderr: ${stderr}`)
    }
    else {
        console.log(`dro process ended with stdout: ${stdout}, stderr: ${stderr}`)
    }

    running = false

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
}

// Do exponential backoff on HTTP error responses from the provider, or indeed anything that can
// kill the dro process.
async function main() {
    running = false
    retries = 0

    do {
        // TODO: Does this allow the event loop to run?
        if (running) continue

        retries++

        try {
            // After some time of the process running successfully, reset our retry count.
            restartProcessTimer()

            console.log(`Starting new dro process`)

            // exec() will not block while the child process is running. The Node.js event loop
            // will be allowed to run.
            const process = cp.exec(DRO_PROCESS, {'cwd': DRO_DIR}, onProcessEnded)
            running = true
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
                console.log(`dro process failed to start with Javascript Error instance: ${JSON.stringify(e)}`)
            }
            else {
                console.log(`dro process failed to start with error: ${JSON.stringify(e)}`)
            }
        }


    } while (true)
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
