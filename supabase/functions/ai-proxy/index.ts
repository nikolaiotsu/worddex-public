import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type Provider = 'claude' | 'gemini' | 'vision'

interface AiProxyRequest {
  provider: Provider
  body: unknown
  extraHeaders?: Record<string, string>
  /** Only used when provider === 'gemini' */
  geminiModel?: string
}

const RATE: Record<Provider, { max: number; windowSec: number }> = {
  claude: { max: 30, windowSec: 60 },
  gemini: { max: 15, windowSec: 60 },
  vision: { max: 60, windowSec: 60 },
}

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages'
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-lite'
const VISION_URL = 'https://vision.googleapis.com/v1/images:annotate'

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'No authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const token = authHeader.replace('Bearer ', '')
    const {
      data: { user },
      error: authError,
    } = await supabaseAdmin.auth.getUser(token)

    if (authError || !user) {
      return new Response(
        JSON.stringify({
          error: 'Invalid authentication token',
          details: authError?.message,
        }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    let payload: AiProxyRequest
    try {
      payload = await req.json()
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { provider, body, extraHeaders, geminiModel } = payload
    if (!provider || !['claude', 'gemini', 'vision'].includes(provider)) {
      return new Response(JSON.stringify({ error: 'Invalid or missing provider' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (body === undefined || body === null) {
      return new Response(JSON.stringify({ error: 'Missing body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const limits = RATE[provider as Provider]
    const { data: allowed, error: rpcError } = await supabaseAdmin.rpc('check_rate_limit', {
      p_user_id: user.id,
      p_provider: provider,
      p_max_requests: limits.max,
      p_window_seconds: limits.windowSec,
    })

    if (rpcError) {
      console.error('check_rate_limit RPC error:', rpcError)
      return new Response(JSON.stringify({ error: 'Rate limit check failed', details: rpcError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (allowed !== true) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded', code: 'RATE_LIMIT' }), {
        status: 429,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (provider === 'claude') {
      const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
      if (!apiKey) {
        return new Response(JSON.stringify({ error: 'Claude API not configured on server' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
        ...(extraHeaders || {}),
      }

      const upstream = await fetch(CLAUDE_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      const text = await upstream.text()
      let json: unknown
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        json = { raw: text }
      }

      return new Response(JSON.stringify(json), {
        status: upstream.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (provider === 'gemini') {
      const apiKey = Deno.env.get('GEMINI_API_KEY')
      if (!apiKey) {
        return new Response(JSON.stringify({ error: 'Gemini API not configured on server' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const model = geminiModel || DEFAULT_GEMINI_MODEL
      const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`

      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
        body: JSON.stringify(body),
      })

      const text = await upstream.text()
      let json: unknown
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        json = { raw: text }
      }

      return new Response(JSON.stringify(json), {
        status: upstream.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // vision
    const apiKey = Deno.env.get('GOOGLE_CLOUD_VISION_API_KEY')
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'Vision API not configured on server' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const url = `${VISION_URL}?key=${encodeURIComponent(apiKey)}`
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
      body: JSON.stringify(body),
    })

    const text = await upstream.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = { raw: text }
    }

    return new Response(JSON.stringify(json), {
      status: upstream.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('ai-proxy error:', error)
    return new Response(
      JSON.stringify({
        error: 'An unexpected error occurred',
        details: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
