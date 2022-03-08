import * as cp from 'child_process'

console.log(`Running the dro process`)

// TODO: Later: npm run prod.
cp.execSync('npm run n', {'cwd': '../dro'})

console.log('dro process ended')
