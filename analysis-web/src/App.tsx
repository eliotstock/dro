import React, { useEffect } from 'react';
import './App.css';
import { createChart, UTCTimestamp } from 'lightweight-charts';
import Papa, { ParseRemoteConfig, ParseResult } from 'papaparse';
// import readRemoteFile from 'react-papaparse'
import moment from 'moment'

// TODO: Get typings from analytics project next door.
class SwapEvent {
  blockTimestamp: string
  tick: number
  priceUsdc?: number

  constructor(
      _blockTimestamp: string,
      _tick: number
  ) {
      this.blockTimestamp = _blockTimestamp
      this.tick = _tick
  }
}

const TIMESTAMP_FORMAT = 'YYYY-MM-DDTHH:mm:ss.SSSZ'

const UNISWAP_V3_LAUNCH_DATE = moment('2021-05-05T00:00:00.000Z', TIMESTAMP_FORMAT)

function Chart(this: any) {
  const ref = React.useRef(null);

  useEffect(() => {
    if (!ref.current) return

    const chart = createChart(ref.current, { width: 1800, height: 1000 });
    const lineSeries = chart.addLineSeries()

    async function getData() {
      // Waiting on issue: https://github.com/Bunlong/react-papaparse/issues/101
      // readRemoteFile('/swap_events.csv', {
      //   worker: true,
      //   step: (results: any) => {
      //     console.log('Row:', results.data)
      //   }
      // })

      // const response = await fetch('/swap_events.csv')
      // console.log('Response:')
      // console.dir(response)
  
      // if (!response.body) {
      //   return
      // }

      // // response.headers['Content-length']
  
      // let rows = []
      // const timeValuePairs: any = []
  
      // const reader = response.body.getReader()
      // const result = await reader.read() // raw array

      // console.log(`Result size: ${result.value?.length}`)
      // // console.log(`Result value 0: ${result.value}`)

      // const decoder = new TextDecoder('utf-8')
      // const csv = decoder.decode(result.value) // the csv text

      // console.log(`csv length (chars): ${csv.length}`)

      // function onComplete(results: ParseResult<T>, file: TInput) {
      //   console.log("Parsing complete:", results, file);
      // }
      
      // const config: ParseRemoteConfig = { header: true, download: true, complete: onComplete }
      // Papa.parse('/swap_events.csv', config)
      // rows = results.data // array of objects

      // console.log(`Errors:`)
      // console.dir(results.errors)
  
      // console.log(`Got ${rows.length} rows`)
      // // console.log(`First row timestamp: ${rows[0]['blockTimestamp']}`)
      // // console.dir(rows[0])
  
      // rows.forEach(row => {
      //   const swapEvent = row as SwapEvent

      //   // Skip any incomplete rows, which should only happen if the response body itself is
      //   // incomplete.
      //   if (!swapEvent.priceUsdc) {
      //     return
      //   }

      //   const timestamp = moment(swapEvent.blockTimestamp, TIMESTAMP_FORMAT)
      //   const unixTime = timestamp.unix() as UTCTimestamp
        
      //   if (unixTime > UNISWAP_V3_LAUNCH_DATE.unix()) {
      //     let timeValuePair = {time: unixTime, value: swapEvent.priceUsdc}
      //     timeValuePairs.push(timeValuePair)
      //   }
      // })

      // lineSeries.setData(timeValuePairs)
    }

    getData()
  }, [ref]);

  return (
    <>
      <div ref={ref} />
    </>
  );
}

export default Chart;
