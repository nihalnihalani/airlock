#!/usr/bin/env bash
# probe_inference.sh — reproducible compatibility probe for Vultr Serverless Inference
#
# STATUS: NOT RUN. Written 2026-09-26 ~16:45 IST (04:15 PDT) without an inference API key.
#         Run it once the team has a Serverless Inference subscription key (after kickoff).
#
# Usage:
#   export VULTR_INFERENCE_API_KEY=...        # per-subscription inference key (NOT the account API key)
#   ./probe_inference.sh                      # probes default models
#   MODELS="glm-5.3 deepseek-v4-flash-0731" ./probe_inference.sh
#   BURST=8 ./probe_inference.sh              # also fire 8 concurrent tiny requests to look for 429s
#
# Requirements: bash 4+, curl, jq. Output: ./probe-out-<UTC timestamp>/ with raw responses
# and summary.jsonl (one JSON line per test). The key is never written to disk or echoed.
# Cost guard: every generation request caps max_completion_tokens (default 512). A full run over
# 4 models is well under 100k tokens (< $0.30 even at the $3/M output of glm-5.3).

set -uo pipefail

: "${VULTR_INFERENCE_API_KEY:?set VULTR_INFERENCE_API_KEY (inference subscription key)}"
BASE="${VINF_BASE:-https://api.vultrinference.com/v1}"
MODELS="${MODELS:-glm-5.3 deepseek-v4-flash-0731 qwen3.8-flash-next glm-5.3-flash}"
MAXTOK="${MAXTOK:-512}"
TIMEOUT="${TIMEOUT:-90}"
BURST="${BURST:-0}"
OUT="probe-out-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
SUMMARY="$OUT/summary.jsonl"

command -v jq >/dev/null || { echo "jq required"; exit 1; }

AUTH=(-H "Authorization: Bearer ${VULTR_INFERENCE_API_KEY}" -H "Content-Type: application/json")

log() { # test model key=value-json
  jq -cn --arg test "$1" --arg model "$2" --argjson data "$3" \
     --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{ts:$ts,test:$test,model:$model}+$data' >> "$SUMMARY"
  echo "[$1] $2 -> $3"
}

# post <outfile> <json-body> [extra curl args]  -> prints "http_code time_total time_starttransfer"
post() {
  local out="$1" body="$2"; shift 2
  curl -sS -m "$TIMEOUT" -o "$out" -w '%{http_code} %{time_total} %{time_starttransfer}' \
       "${AUTH[@]}" -X POST "$BASE/chat/completions" -d "$body" "$@" 2>>"$OUT/curl-errors.log"
}

TOOLS_RUN='[{"type":"function","function":{"name":"run_in_sandbox","description":"Run a shell command inside an isolated sandbox and return stdout","parameters":{"type":"object","properties":{"cmd":{"type":"string","description":"shell command"},"timeout_s":{"type":"integer","minimum":1,"maximum":60}},"required":["cmd","timeout_s"]}}}]'
TOOLS_TWO='[{"type":"function","function":{"name":"get_weather","description":"Weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}},{"type":"function","function":{"name":"get_time","description":"Local time for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]'

# ---------- 0. catalog (public, no key needed) ----------
curl -sS -m 30 "$BASE/models" -o "$OUT/models.json"
jq -c '[.data[] | {id, tools: (.output_modalities[0].supported_parameters.tools != null),
        ctx: ([.input_modalities[]?.supported_inputs.max_context_length.value] | map(select(.!=null)) | first),
        inputs: [.input_modalities[].type],
        reasoning_budget: (.reasoning.supports_max_tokens // null)}]' "$OUT/models.json" > "$OUT/models.summary.json"
log catalog "-" "$(jq -c '{n: length, tool_models: [ .[] | select(.tools) | .id ]}' "$OUT/models.summary.json")"
code=$(curl -sS -m 30 -o /dev/null -w '%{http_code}' "$BASE/chat/models"); log guide_url_chat_models "-" "$(jq -cn --arg h "$code" '{http:$h}')"
code=$(curl -sS -m 30 -o "$OUT/models_all.json" -w '%{http_code}' "${AUTH[@]}" "$BASE/models/all"); log models_all "-" "$(jq -cn --arg h "$code" --arg n "$(jq '.data|length' "$OUT/models_all.json" 2>/dev/null || echo null)" '{http:$h,n:$n}')"

for M in $MODELS; do
  S="$OUT/$M"; mkdir -p "$S"

  # ---------- 1. basic non-streaming + usage ----------
  r=$(post "$S/basic.json" "$(jq -cn --arg m "$M" --argjson t "$MAXTOK" '{model:$m,max_completion_tokens:$t,reasoning_effort:"low",
        messages:[{role:"user",content:"Reply with exactly: PONG"}]}')")
  read -r http tt ttfb <<<"$r"
  log basic "$M" "$(jq -c --arg h "$http" --arg tt "$tt" '{http:($h|tonumber),secs:($tt|tonumber),
        content:(.choices[0].message.content // null), finish:(.choices[0].finish_reason // null),
        has_reasoning_content:(.choices[0].message.reasoning_content!=null), has_reasoning:(.choices[0].message.reasoning!=null),
        usage:(.usage // null), err:(.error // .message // null)}' "$S/basic.json" 2>/dev/null || echo "{\"http\":\"$http\",\"parse\":\"fail\"}")"

  # ---------- 2. tiny budget + high effort: does content come back empty? ----------
  post "$S/budget.json" "$(jq -cn --arg m "$M" '{model:$m,max_completion_tokens:64,reasoning_effort:"high",
        messages:[{role:"user",content:"What is 17*23? Answer with the number only."}]}')" >/dev/null
  log tiny_budget_high_effort "$M" "$(jq -c '{content:(.choices[0].message.content // null), finish:(.choices[0].finish_reason // null), usage:(.usage // null), err:(.error // .message // null)}' "$S/budget.json" 2>/dev/null || echo '{"parse":"fail"}')"

  # ---------- 3. reasoning_effort "none" accepted? (spec: unsupported levels -> 422) ----------
  r=$(post "$S/effort_none.json" "$(jq -cn --arg m "$M" '{model:$m,max_completion_tokens:32,reasoning_effort:"none",messages:[{role:"user",content:"Say hi"}]}')")
  read -r http tt ttfb <<<"$r"; log effort_none "$M" "$(jq -cn --arg h "$http" --arg t "$tt" '{http:$h,secs:$t}')"

  # ---------- 4. streaming: chunk count, TTFB, [DONE], usage in stream? ----------
  r=$(post "$S/stream.sse" "$(jq -cn --arg m "$M" --argjson t "$MAXTOK" '{model:$m,stream:true,max_completion_tokens:$t,reasoning_effort:"low",
        messages:[{role:"user",content:"Count from 1 to 20 separated by spaces."}]}')" -N)
  read -r http tt ttfb <<<"$r"
  chunks=$(grep -c '^data: {' "$S/stream.sse" || true)
  done_marker=$(grep -c '^data: \[DONE\]' "$S/stream.sse" || true)
  usage_in_stream=$( { grep '^data: {' "$S/stream.sse" || true; } | sed 's/^data: //' | jq -s 'map(select(.usage!=null)) | length' 2>/dev/null)
  reasoning_deltas=$(grep -c 'reasoning_content' "$S/stream.sse" || true)
  log stream "$M" "$(jq -cn --arg h "$http" --arg f "$ttfb" --arg t "$tt" --arg c "$chunks" --arg d "$done_marker" --arg u "$usage_in_stream" --arg r "$reasoning_deltas" '{http:$h,ttfb_s:$f,secs:$t,chunks:$c,done_marker:$d,usage_chunks:$u,reasoning_content_chunks:$r}')"

  for SUFFIX in "" "-normalize"; do
    MM="$M$SUFFIX"; tag="${SUFFIX:-raw}"

    # ---------- 5. forced tool call: id format, arguments validity, content null? ----------
    post "$S/tool_forced$SUFFIX.json" "$(jq -cn --arg m "$MM" --argjson tools "$TOOLS_RUN" --argjson t "$MAXTOK" '{model:$m,max_completion_tokens:$t,reasoning_effort:"low",
          tools:$tools, tool_choice:{type:"function",function:{name:"run_in_sandbox"}},
          messages:[{role:"user",content:"List the files in /work with a 10 second timeout."}]}')" >/dev/null
    log "tool_forced_$tag" "$MM" "$(jq -c '{finish:(.choices[0].finish_reason // null),
          n_calls:(.choices[0].message.tool_calls|length? // 0),
          id:(.choices[0].message.tool_calls[0].id // null),
          id_standard:((.choices[0].message.tool_calls[0].id // "") | test("^(call_|chatcmpl-tool-)")),
          args_raw:(.choices[0].message.tool_calls[0].function.arguments // null),
          args_parse_ok:((.choices[0].message.tool_calls[0].function.arguments // "x") | try (fromjson | type=="object") catch false),
          content_is_null:(.choices[0].message.content==null),
          err:(.error // .message // null)}' "$S/tool_forced$SUFFIX.json" 2>/dev/null || echo '{"parse":"fail"}')"

    # ---------- 6. multi-step: feed tool result back (tool_call_id round trip) ----------
    CALL_ID=$(jq -r '.choices[0].message.tool_calls[0].id // empty' "$S/tool_forced$SUFFIX.json" 2>/dev/null)
    ASSIST=$(jq -c '.choices[0].message' "$S/tool_forced$SUFFIX.json" 2>/dev/null)
    if [[ -n "$CALL_ID" && -n "$ASSIST" ]]; then
      post "$S/tool_multistep$SUFFIX.json" "$(jq -cn --arg m "$MM" --argjson tools "$TOOLS_RUN" --argjson a "$ASSIST" --arg id "$CALL_ID" --argjson t "$MAXTOK" '{model:$m,max_completion_tokens:$t,reasoning_effort:"low",tools:$tools,tool_choice:"auto",
            messages:[{role:"user",content:"List the files in /work with a 10 second timeout, then tell me how many there are."},
                      ($a | del(.reasoning_content) | del(.reasoning)),
                      {role:"tool",tool_call_id:$id,content:"exit_code=0\nstdout:\ndata.csv\nreport.md\nrun.py\n"}]}')" >/dev/null
      log "tool_multistep_$tag" "$MM" "$(jq -c '{finish:(.choices[0].finish_reason // null), content:(.choices[0].message.content // null),
            mentions_3:((.choices[0].message.content // "") | test("\\b3\\b|three";"i")), err:(.error // .message // null)}' "$S/tool_multistep$SUFFIX.json" 2>/dev/null || echo '{"parse":"fail"}')"
    else
      log "tool_multistep_$tag" "$MM" '{"skipped":"no tool call id from step 5"}'
    fi
  done

  # ---------- 7. streaming tool call: are tool_call deltas well-formed & assemblable? ----------
  post "$S/tool_stream.sse" "$(jq -cn --arg m "$M-normalize" --argjson tools "$TOOLS_RUN" '{model:$m,stream:true,max_completion_tokens:512,reasoning_effort:"low",
        tools:$tools,tool_choice:"required",messages:[{role:"user",content:"Run: echo hello (timeout 5)"}]}')" -N >/dev/null
  assembled=$( { grep '^data: {' "$S/tool_stream.sse" || true; } | sed 's/^data: //' | jq -rs '[.[].choices[0].delta.tool_calls[0].function.arguments? // empty] | join("")' 2>/dev/null)
  ok=$(jq -n --arg a "$assembled" '$a | try (fromjson | type=="object") catch false')
  log tool_stream_normalize "$M-normalize" "$(jq -cn --arg ok "$ok" --arg a "$assembled" '{assembled_args_parse_ok:$ok,assembled:$a}')"

  # ---------- 8. parallel tool calls (no parallel_tool_calls param in spec; observe behaviour) ----------
  post "$S/tool_parallel.json" "$(jq -cn --arg m "$M-normalize" --argjson tools "$TOOLS_TWO" '{model:$m,max_completion_tokens:512,reasoning_effort:"low",tools:$tools,tool_choice:"auto",
        messages:[{role:"user",content:"Get the weather AND the local time for Paris. Call both tools."}]}')" >/dev/null
  log tool_parallel "$M-normalize" "$(jq -c '{n_calls:(.choices[0].message.tool_calls|length? // 0), names:[.choices[0].message.tool_calls[]?.function.name]}' "$S/tool_parallel.json" 2>/dev/null || echo '{"parse":"fail"}')"

  # ---------- 9. invalid args from model: ask for a value that violates the schema; strict:true ----------
  STRICT_TOOLS=$(jq -c '.[0].function.strict=true' <<<"$TOOLS_RUN")
  post "$S/tool_strict.json" "$(jq -cn --arg m "$M-normalize" --argjson tools "$STRICT_TOOLS" '{model:$m,max_completion_tokens:512,reasoning_effort:"low",tools:$tools,tool_choice:"required",
        messages:[{role:"user",content:"Run ls with a timeout of \"forever\"."}]}')" >/dev/null
  log tool_invalid_args_strict "$M-normalize" "$(jq -c '{args:(.choices[0].message.tool_calls[0].function.arguments // null),
        timeout_is_int:((.choices[0].message.tool_calls[0].function.arguments // "{}") | (try (fromjson.timeout_s|type=="number") catch false)), err:(.error // .message // null)}' "$S/tool_strict.json" 2>/dev/null || echo '{"parse":"fail"}')"

  # ---------- 10. JSON mode: response_format is NOT in the spec — does it 400/422 or get ignored? ----------
  r=$(post "$S/json_mode.json" "$(jq -cn --arg m "$M" '{model:$m,max_completion_tokens:256,reasoning_effort:"low",response_format:{type:"json_object"},
        messages:[{role:"user",content:"Return a JSON object with key a=1. JSON only."}]}')")
  read -r http tt ttfb <<<"$r"
  log json_mode_unsupported_param "$M" "$(jq -c --arg h "$http" '{http:($h|tonumber), content:(.choices[0].message.content // null), err:(.error // .message // .detail // null)}' "$S/json_mode.json" 2>/dev/null || echo "{\"http\":$http}")"
done

# ---------- 11. server-side validation errors ----------
r=$(post "$OUT/err_unknown_model.json" '{"model":"does-not-exist","messages":[{"role":"user","content":"x"}]}'); log err_unknown_model "does-not-exist" "$(jq -cn --arg h "${r%% *}" --rawfile b "$OUT/err_unknown_model.json" '{http:$h,body:$b}')"
r=$(post "$OUT/err_bad_tool_schema.json" "$(jq -cn --arg m "${MODELS%% *}" '{model:$m,messages:[{role:"user",content:"x"}],tools:[{type:"function",function:{name:"bad name with spaces",parameters:"not-an-object"}}]}')"); log err_bad_tool_schema "${MODELS%% *}" "$(jq -cn --arg h "${r%% *}" --rawfile b "$OUT/err_bad_tool_schema.json" '{http:$h,body:$b}')"
r=$(post "$OUT/err_orphan_tool_msg.json" "$(jq -cn --arg m "${MODELS%% *}" '{model:$m,max_completion_tokens:32,messages:[{role:"user",content:"x"},{role:"tool",tool_call_id:"nope",content:"y"}]}')"); log err_orphan_tool_message "${MODELS%% *}" "$(jq -cn --arg h "${r%% *}" --rawfile b "$OUT/err_orphan_tool_msg.json" '{http:$h,body:$b}')"

# ---------- 12. client timeout behaviour (does a 3s client timeout leave the server generating? we can only observe the client) ----------
code=$(curl -sS -m 3 -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST "$BASE/chat/completions" \
       -d "$(jq -cn --arg m "${MODELS%% *}" '{model:$m,max_completion_tokens:4000,reasoning_effort:"high",messages:[{role:"user",content:"Write a 3000-word essay on sandboxes."}]}')" 2>&1; echo " exit=$?")
log client_timeout_3s "${MODELS%% *}" "$(jq -cn --arg c "$code" '{result:$c}')"

# ---------- 13. Anthropic-format endpoint with a tool (optional path for Anthropic SDK users) ----------
curl -sS -m "$TIMEOUT" -o "$OUT/messages_tool.json" "${AUTH[@]}" -X POST "$BASE/messages" -d "$(jq -cn --arg m "${MODELS%% *}" '{model:$m,max_tokens:512,
   tools:[{name:"run_in_sandbox",description:"run a command",input_schema:{type:"object",properties:{cmd:{type:"string"}},required:["cmd"]}}],
   messages:[{role:"user",content:"Use the tool to run: echo hi"}]}')"
log anthropic_messages_tool "${MODELS%% *}" "$(jq -c '{stop_reason:(.stop_reason // null), blocks:[.content[]?.type], err:(.error // .message // null)}' "$OUT/messages_tool.json" 2>/dev/null || echo '{"parse":"fail"}')"

# ---------- 14. usage endpoint (token/cost reporting) ----------
code=$(curl -sS -m 30 -o "$OUT/usage.json" -w '%{http_code}' "${AUTH[@]}" "$BASE/usage"); log usage_endpoint "-" "$(jq -cn --arg h "$code" --arg b "$(head -c 600 "$OUT/usage.json")" '{http:$h,body_head:$b}')"

# ---------- 15. optional burst for rate limits (429 + headers) ----------
if [[ "$BURST" -gt 0 ]]; then
  for i in $(seq 1 "$BURST"); do
    ( curl -sS -m "$TIMEOUT" -D "$OUT/burst_$i.headers" -o "$OUT/burst_$i.json" -w '%{http_code}\n' "${AUTH[@]}" -X POST "$BASE/chat/completions" \
        -d "$(jq -cn --arg m "${MODELS%% *}" '{model:$m,max_completion_tokens:8,reasoning_effort:"low",messages:[{role:"user",content:"hi"}]}')" > "$OUT/burst_$i.code" ) &
  done; wait
  codes=$(cat "$OUT"/burst_*.code | sort | uniq -c | tr '\n' ';')
  rl_headers=$(grep -hi -E '^(x-ratelimit|retry-after|ratelimit)' "$OUT"/burst_*.headers | sort -u | tr '\r\n' '  ')
  log burst "${MODELS%% *}" "$(jq -cn --arg c "$codes" --arg h "$rl_headers" '{codes:$c, ratelimit_headers:$h}')"
fi

echo; echo "Done. Summary: $SUMMARY"
echo "Paste summary.jsonl lines into research/experiments.jsonl (status: RUN) — never paste the key."
