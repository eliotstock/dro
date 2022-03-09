import * as cp from 'child_process'

const BACKOFF_RETRIES_MAX = 6
const BACKOFF_DELAY_BASE_SEC = 6

function sleep(seconds: number) {
    return new Promise((resolve) => {
        setTimeout(resolve, seconds * 1000);
    })
}

// Do exponential backoff on HTTP error responses from the provider, or indeed anything that can
// kill the dro process.
async function main() {
    console.log(`Running the dro process with back-off`)

    let retries = 0

    do {
        retries++

        // We do not define the command line for the actual dro process here - that's a script in
        // the package.json for the dro module next door.
        // execSync() will block while the child process is running.
        cp.execSync('npm run prod', {'cwd': '../dro'})

        console.log('dro process died')

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
