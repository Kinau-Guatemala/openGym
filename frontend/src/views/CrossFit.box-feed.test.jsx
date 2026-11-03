// @vitest-environment happy-dom
// T31: Settings → CrossFit shows the box feed's link and QR code, only to the account the server
// says it publishes (/api/config boxFeed).
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { DEF, useStore } from '../store/useStore.js'
import { CrossFitSettings } from './CrossFit.jsx'

vi.mock('../components/QrCanvas.jsx', () => ({ default: ({ value }) => <canvas data-qr={value} /> }))

const URL = 'https://raw.githubusercontent.com/Kinau-Guatemala/holy-wods/main/feed.json'
let root, host
async function mount() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const S = JSON.parse(JSON.stringify(DEF))
  await act(async () => root.render(<CrossFitSettings S={S} update={() => {}} />))
}

beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('the box feed in Settings → CrossFit', () => {
  it('shows the feed URL and its QR code for the publishing account', async () => {
    useStore.setState({ config: { boxFeed: { url: URL } } })
    await mount()
    expect(host.querySelector('canvas[data-qr]').dataset.qr).toBe(URL)
    expect(host.querySelector(`a[href="${URL}"]`).textContent).toBe(URL)
    expect(host.textContent).toContain('Box feed')
  })

  it('shows nothing of it when the server reports no feed for this account', async () => {
    useStore.setState({ config: { coach: null } })
    await mount()
    expect(host.querySelector('canvas[data-qr]')).toBeNull()
    expect(host.textContent).not.toContain('Box feed')
  })
})
