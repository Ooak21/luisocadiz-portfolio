// IMC Agent Session — Supabase Edge Function
// Creates a one-time session code tied to a wallet for voice agent auth
// Stores in imc_agent_sessions table
// On free Telnyx tier: single inbound number + session code validation
// On paid tier: upgrade to per-session number provisioning

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TELNYX_KEY   = Deno.env.get('TELNYX_API_KEY')!
const IMC_NUMBER   = Deno.env.get('TELNYX_PHONE_NUMBER') || '+17757992718'
const SESSION_TTL  = 15 * 60 * 1000 // 15 minutes

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

// Generate a 6-digit OTP code
function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

// Generate a random session ID
function generateSessionId(): string {
  return crypto.randomUUID()
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET',
        'Access-Control-Allow-Headers': 'authorization, content-type'
      }
    })
  }

  try {
    const body = await req.json()
    const action = body.action || 'create'

    // ── CREATE SESSION ──────────────────────────────────────────────
    if (action === 'create') {
      const { wallet_address, application_id } = body

      if (!wallet_address) {
        return new Response(JSON.stringify({ error: 'wallet_address required' }), { status: 400 })
      }

      // Expire any existing sessions for this wallet
      await supabase
        .from('imc_agent_sessions')
        .update({ used: true })
        .eq('wallet_address', wallet_address)
        .eq('used', false)

      // Generate session code
      const session_code = generateCode()
      const session_id = generateSessionId()
      const expires_at = new Date(Date.now() + SESSION_TTL).toISOString()

      // Store session
      const { error } = await supabase
        .from('imc_agent_sessions')
        .insert({
          id: session_id,
          wallet_address,
          application_id: application_id || null,
          session_code,
          phone_number: IMC_NUMBER,
          expires_at,
          used: false
        })

      if (error) throw new Error(error.message)

      return new Response(JSON.stringify({
        success: true,
        phone_number: IMC_NUMBER,
        session_code,
        expires_at,
        instructions: `Call ${IMC_NUMBER} and provide code ${session_code} when prompted. Valid for 15 minutes.`
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })
    }

    // ── VALIDATE SESSION (called by voice agent) ────────────────────
    if (action === 'validate') {
      const { session_code } = body

      if (!session_code) {
        return new Response(JSON.stringify({ valid: false, reason: 'No code provided' }), { status: 400 })
      }

      const { data: sessions } = await supabase
        .from('imc_agent_sessions')
        .select('*')
        .eq('session_code', session_code)
        .eq('used', false)
        .gt('expires_at', new Date().toISOString())
        .limit(1)

      if (!sessions || sessions.length === 0) {
        return new Response(JSON.stringify({
          valid: false,
          reason: 'Invalid or expired session code'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        })
      }

      const session = sessions[0]

      // Mark session as used — one time only
      await supabase
        .from('imc_agent_sessions')
        .update({ used: true, used_at: new Date().toISOString() })
        .eq('id', session.id)

      // Fetch full application data for the agent
      const { data: apps } = await supabase
        .from('imc_applications')
        .select('id,first_name,last_name,vehicle_name,loan_amount,final_apr,term_months,status,vault_contract,email,phone,servicing_status,days_past_due,last_payment_at,last_payment_amount,payment_due_date')
        .eq('wallet_address', session.wallet_address)
        .order('created_at', { ascending: false })

      // Log the agent session to account notes
      if (apps && apps.length > 0) {
        const primaryApp = session.application_id
          ? apps.find(a => a.id === session.application_id) || apps[0]
          : apps[0]

        await supabase
          .from('imc_account_notes')
          .insert({
            application_id: primaryApp.id,
            entered_by_wallet: 'VOICE_AGENT_INBOUND',
            entered_by_name: 'IMC Voice Agent',
            role_level_at_entry: 1,
            reason_code: 'SVC',
            note_text: `Inbound voice agent session authenticated. Session code verified. Caller identity confirmed via OTP.`,
            is_system_generated: true,
            related_ls_code: 'LS-001'
          })
      }

      return new Response(JSON.stringify({
        valid: true,
        wallet_address: session.wallet_address,
        applications: apps || []
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })
    }

    // ── EXPIRE OLD SESSIONS (maintenance) ──────────────────────────
    if (action === 'cleanup') {
      const { error } = await supabase
        .from('imc_agent_sessions')
        .update({ used: true })
        .lt('expires_at', new Date().toISOString())
        .eq('used', false)

      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400 })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return new Response(JSON.stringify({ error: msg }), { status: 500 })
  }
})
