import assert from 'node:assert/strict'
import { test } from 'node:test'

globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'

const sse = (...events) =>
  new Response(
    [...events, { type: 'message_stop' }]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )

const block = (index, content_block) => ({
  type: 'content_block_start',
  index,
  content_block,
})

const thirdParty = {
  baseUrl: 'https://provider.example/anthropic/v1',
  apiKey: 'chat-key',
  searchApiKey: 'deepseek-search-key',
  model: 'third-party-model',
  effort: 'high',
  contextTokens: 1_048_576,
  maxOutputTokens: 393_216,
}

const question = {
  messages: [{ role: 'user', content: '查一下示例城市的人口' }],
  thinking: true,
  search: true,
  title: false,
}

test('an installed client never sends official Messages through WebView fetch', async (t) => {
  const { request } = await import('../node_modules/.cache/chat-tests/src/services/api/client.js')
  const { mockIPC, clearMocks } = await import('@tauri-apps/api/mocks')
  const oldWindow = globalThis.window
  globalThis.window = globalThis
  globalThis.isTauri = true
  t.after(() => {
    clearMocks()
    delete globalThis.isTauri
    if (oldWindow === undefined) delete globalThis.window
    else globalThis.window = oldWindow
  })
  const browser = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected WebView fetch') })
  const appCalls = []
  mockIPC((cmd) => {
    appCalls.push(cmd)
    if (cmd === 'native_http_prepare') return 42
    if (cmd === 'native_http_send') return { status: 401, headers: [['content-type', 'application/json']] }
    if (cmd === 'native_http_read') return new ArrayBuffer(0)
    if (cmd === 'native_http_close') return
    throw new Error(`Unexpected IPC: ${cmd}`)
  })
  await assert.rejects(request('https://api.deepseek.com/anthropic/v1/messages', {method:'POST',body:'{}'}),
    (error) => error.status === 401)
  assert.equal(browser.mock.callCount(), 0)
  assert.ok(appCalls.includes('native_http_close'))
})

test('uses DeepSeek search evidence in the configured model reply with separate credentials', async (t) => {
  const { streamChat } = await import('../node_modules/.cache/chat-tests/src/services/api/chat.js')
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({
      url,
      key: new Headers(init.headers).get('x-api-key'),
      body: JSON.parse(init.body),
    })
    return requests.length === 1
      ? sse(
          block(0, {
            type: 'server_tool_use',
            id: 'search-1',
            name: 'deepseek_web_search',
            kind: 'deep_search',
            input: { action: 'search', queries: ['示例城市 人口'] },
          }),
          block(1, {
            type: 'web_search_tool_result',
            tool_use_id: 'search-1',
            kind: 'deep_search',
            content: [
              {
                type: 'web_search_result',
                title: '人口普查',
                url: 'https://source.example/census',
                snippet: '示例城市人口为 37 万',
                encrypted_content: 'opaque-deepseek-data',
              },
            ],
          }),
          block(2, { type: 'text', text: '普查于 2025 年发布。' })
        )
      : sse(block(0, { type: 'text', text: '第三方模型解读' }))
  })

  const events = await Array.fromAsync(
    streamChat(thirdParty, question, new AbortController().signal)
  )
  assert.deepEqual(
    requests.map(({ url, key }) => [url, key]),
    [
      ['https://api.deepseek.com/anthropic/v1/messages', 'deepseek-search-key'],
      ['https://provider.example/anthropic/v1/messages', 'chat-key'],
    ]
  )
  const [searchRequest, answerRequest] = requests.map(({ body }) => body)
  assert.equal(searchRequest.model, 'deepseek-flash')
  assert.deepEqual(
    searchRequest.tools.map(({ type }) => type),
    ['deepseek_read_url', 'deepseek_web_search']
  )
  assert.deepEqual(searchRequest.output_config, { effort: 'high' })
  assert.equal(answerRequest.model, 'third-party-model')
  assert.equal(answerRequest.max_tokens, 393_216)
  assert.deepEqual(answerRequest.output_config, { effort: 'high' })
  assert.equal(answerRequest.tools, undefined)
  const context = JSON.stringify(answerRequest.messages)
  assert.match(context, /查一下示例城市的人口/)
  assert.match(context, /示例城市人口为 37 万/)
  assert.match(context, /https:\/\/source\.example\/census/)
  assert.match(context, /普查于 2025 年发布/)
  assert.doesNotMatch(context, /opaque-deepseek-data|deepseek-search-key/)
  const blocks = events
    .filter((event) => event.type === 'content_block_start')
    .map(({ content_block }) => content_block)
  assert.ok(blocks.some(({ type }) => type === 'web_search_tool_result'))
  assert.deepEqual(
    blocks.filter(({ type }) => type === 'text').map(({ text }) => text),
    ['第三方模型解读']
  )
})

test('keeps the default DeepSeek route without search when a saved toggle has no search key', async (t) => {
  const { streamChat } = await import('../node_modules/.cache/chat-tests/src/services/api/chat.js')
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) })
    return sse(block(0, { type: 'text', text: 'DeepSeek 回复' }))
  })

  const config = {
    ...thirdParty,
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    searchApiKey: null,
  }
  await Array.fromAsync(
    streamChat(config, { ...question, thinking: false }, new AbortController().signal)
  )
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://api.deepseek.com/anthropic/v1/messages')
  assert.deepEqual(requests[0].body.thinking, { type: 'disabled' })
  assert.equal(requests[0].body.output_config, undefined)
  assert.deepEqual(
    requests[0].body.tools.map(({ name }) => name),
    ['deepseek_read_url']
  )
})

test('with search off a plain question goes straight to the configured model', async (t) => {
  const { streamChat } = await import('../node_modules/.cache/chat-tests/src/services/api/chat.js')
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({
      url,
      key: new Headers(init.headers).get('x-api-key'),
      body: JSON.parse(init.body),
    })
    return sse(block(0, { type: 'text', text: '直接回答' }))
  })

  await Array.fromAsync(
    streamChat(
      { ...thirdParty, baseUrl: 'https://provider.example/prefix' },
      { ...question, search: false },
      new AbortController().signal
    )
  )
  assert.deepEqual(
    requests.map(({ url, key }) => [url, key]),
    [['https://provider.example/prefix/v1/messages', 'chat-key']]
  )
  assert.equal(requests[0].body.tools, undefined)
})

test('a failed search shows its endpoint and transport and logs no credentials or question', async (t) => {
  const { streamChat } = await import('../node_modules/.cache/chat-tests/src/services/api/chat.js')
  const { describeReply } =
    await import('../node_modules/.cache/chat-tests/src/services/chat/describe.js')
  const requests = t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('Failed to fetch')
  })
  const log = t.mock.method(console, 'error', () => {})
  await assert.rejects(
    Array.fromAsync(streamChat(thirdParty, question, new AbortController().signal)),
    (error) => {
      assert.equal(error.kind, 'network')
      const notice = describeReply({ status: 'error', blocks: [], error })
      assert.match(notice.text, /搜索|search/i)
      assert.match(notice.details, /POST https:\/\/api\.deepseek\.com\/anthropic\/v1\/messages/)
      assert.match(notice.details, /fetch/i)
      assert.match(notice.details, /Failed to fetch/)
      assert.doesNotMatch(notice.details, /HTTP \d{3}|ERR_NETWORK_ACCESS_DENIED/)
      return true
    }
  )
  assert.equal(requests.mock.callCount(), 1)
  const logged = JSON.stringify(log.mock.calls.map((call) => call.arguments))
  assert.match(logged, /search/)
  assert.match(logged, /network/)
  assert.doesNotMatch(logged, /chat-key|deepseek-search-key|示例城市/)
})

test('a link-reading 401 identifies the search key and preserves the service request ID without logging the response', async (t) => {
  const { streamChat } = await import('../node_modules/.cache/chat-tests/src/services/api/chat.js')
  const { describeReply } =
    await import('../node_modules/.cache/chat-tests/src/services/chat/describe.js')
  const log = t.mock.method(console, 'error', () => {})
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      { error: { message: `Key expired: ${thirdParty.searchApiKey}` } },
      {
        status: 401,
        headers: { 'x-request-id': 'req-test-401' },
      }
    )
  )
  const readLink = {
    ...question,
    search: false,
    messages: [{ role: 'user', content: 'Read https://private.example/article' }],
  }
  await assert.rejects(
    Array.fromAsync(streamChat(thirdParty, readLink, new AbortController().signal)),
    (error) => {
      const notice = describeReply({ status: 'error', blocks: [], error })
      assert.equal(error.kind, 'http')
      assert.equal(error.status, 401)
      assert.match(notice.text, /链接读取|link reading/i)
      assert.match(notice.text, /搜索 Key|search key/i)
      assert.match(notice.details, /HTTP 401/)
      assert.match(notice.details, /\/anthropic\/v1\/messages/)
      assert.match(notice.details, /Key expired/)
      assert.match(notice.details, /req-test-401/)
      assert.doesNotMatch(notice.details, /deepseek-search-key/)
      return true
    }
  )
  assert.doesNotMatch(
    JSON.stringify(log.mock.calls.map((call) => call.arguments)),
    /Key expired|deepseek-search-key|private\.example/
  )
})

test('reads a supplied link with the official key even when Smart Search is off', async (t) => {
  const { streamChat } = await import('../node_modules/.cache/chat-tests/src/services/api/chat.js')
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({
      url,
      key: new Headers(init.headers).get('x-api-key'),
      body: JSON.parse(init.body),
    })
    return requests.length === 1
      ? sse(
          block(0, {
            type: 'web_fetch_tool_result',
            tool_use_id: 'link-1',
            kind: 'read_link',
            content: {
              type: 'web_fetch_result',
              url: 'https://source.example/docs',
              content: { title: 'Example docs' },
            },
            signature: 'signed-web-page',
          }),
          block(1, { type: 'text', text: 'The article describes an example.' })
        )
      : sse(block(0, { type: 'text', text: 'Reply based on the page' }))
  })
  await Array.fromAsync(
    streamChat(
      thirdParty,
      {
        messages: [{ role: 'user', content: 'Read https://source.example/docs' }],
        search: false,
        thinking: false,
        title: false,
      },
      new AbortController().signal
    )
  )
  assert.equal(requests[0].key, 'deepseek-search-key')
  assert.equal(requests[0].url, 'https://api.deepseek.com/anthropic/v1/messages')
  assert.deepEqual(
    requests[0].body.tools.map(({ type }) => type),
    ['deepseek_read_url']
  )
  assert.equal(requests[1].key, 'chat-key')
  const context = JSON.stringify(requests[1].body.messages)
  assert.match(context, /The article describes an example/)
  assert.doesNotMatch(context, /signed-web-page/)
})

test('searches attached images with the official key and keeps chat file IDs scoped to the chat provider', async (t) => {
  const { streamChat } = await import('../node_modules/.cache/chat-tests/src/services/api/chat.js')
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return sse()
  })
  const file = { type: 'image', source: { type: 'file', file_id: 'third-party-image' } }
  await Array.fromAsync(
    streamChat(
      thirdParty,
      {
        ...question,
        messages: [{ role: 'user', content: [file] }],
        searchImages: [new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })],
      },
      new AbortController().signal
    )
  )
  assert.deepEqual(
    bodies.map(({ messages }) => messages[0].content),
    [[{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } }], [file]]
  )
})

test('stopping during search aborts it without sending the chat request or logging a failure', async (t) => {
  const { streamChat } = await import('../node_modules/.cache/chat-tests/src/services/api/chat.js')
  const controller = new AbortController()
  const log = t.mock.method(console, 'error', () => {})
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.signal, controller.signal)
    controller.abort()
    throw controller.signal.reason
  })
  await assert.rejects(Array.fromAsync(streamChat(thirdParty, question, controller.signal)), {
    name: 'AbortError',
  })
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal(log.mock.callCount(), 0)
})

test('reserves the configured output and omits old rounds that would exceed the context window', async (t) => {
  const { streamChat } = await import('../node_modules/.cache/chat-tests/src/services/api/chat.js')
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return sse()
  })
  await Array.fromAsync(
    streamChat(
      { ...thirdParty, contextTokens: 128, maxOutputTokens: 64 },
      {
        ...question,
        search: false,
        messages: [
          { role: 'user', content: 'old question '.repeat(100) },
          { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
          { role: 'user', content: 'current question' },
        ],
      },
      new AbortController().signal
    )
  )
  assert.equal(bodies[0].max_tokens, 64)
  assert.deepEqual(bodies[0].messages, [{ role: 'user', content: 'current question' }])
})
