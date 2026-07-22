const fs = require('node:fs');
const { spawn } = require('node:child_process');
const text2wav = require('text2wav');
const { buildWavBuffer, parseWavPcm } = require('../../media/wav');
const { signal, throwResponse } = require('../http');
const { providerResult } = require('../result');

const PIPER_SAMPLE_RATE=22050; // native rate of Piper's "medium" quality voices (lessac/amy/ryan-medium); revisit if a "low" (16000Hz) or other-tier voice is added
// Bytes-per-second for each provider's PCM16 mono output (sampleRate * 2 bytes/sample) -- used to
// derive a `seconds` usage figure so the linear_steps ProviderPriceVersion rate cards for these
// two providers can price against real audio duration instead of a separate hardcoded formula.
const AUDIO_BYTES_PER_SECOND = { piper: PIPER_SAMPLE_RATE * 2, spark: 24000 * 2 };
// One narrator voice per project/provider: every scene is a single synthesis call over its whole
// narrationText, not a per-speaker loop — there is no more per-line voice routing to do.
function createAudioProviders(config,getCancellation,usageTracker,providerAdmission){
  async function stub(text){const {pcm,...fmt}=parseWavPcm(await text2wav(text,{voice:'en',speed:145,pitch:48,amplitude:100}));return{buffer:buildWavBuffer(pcm,fmt),mimeType:'audio/wav',extension:'wav'};}
  function piperAuthHeaders(json=false){const headers={};if(json)headers['Content-Type']='application/json';if(config.piperServiceToken)headers.Authorization=`Bearer ${config.piperServiceToken}`;return headers;}
  function piperLineLocal(text,voice){return new Promise((resolve,reject)=>{const model=`${config.paths.piperVoices}/${voice}.onnx`;if(!fs.existsSync(config.paths.piper)||!fs.existsSync(model))return reject(new Error('Piper is not installed. Run npm run setup:piper.'));const chunks=[];const child=spawn(config.paths.piper,['--model',model,'--output-raw'],{stdio:['pipe','pipe','pipe']});let stderr='';child.stdout.on('data',(x)=>chunks.push(x));child.stderr.on('data',(x)=>stderr+=x);child.on('error',reject);child.on('close',(code)=>code===0?resolve(Buffer.concat(chunks)):reject(new Error(`Piper failed (${code}): ${stderr.trim()}`)));child.stdin.end(text);});}
  async function piperLineRemote(text,voiceId){const response=await fetch(`${config.piperUrl}/synthesize`,{method:'POST',headers:piperAuthHeaders(true),body:JSON.stringify({text,voiceId}),signal:signal(config.env.AUDIO_PROVIDER_TIMEOUT_MS||60_000,getCancellation)});if(!response.ok){const detail=await response.json().catch(()=>({}));throw new Error(detail.detail||`Piper service error (${response.status})`);}const {pcm}=parseWavPcm(Buffer.from(await response.arrayBuffer()));return pcm;}
  function piperLine(text,voice){return config.piperUrl?piperLineRemote(text,voice):piperLineLocal(text,voice);}
  function resolvePiperVoice(voiceId){return config.piperVoices.includes(voiceId)?voiceId:null;}
  async function piper(text,voice){const resolved=resolvePiperVoice(voice?.voiceId)||config.piperVoices[0];const pcm=await piperLine(text,resolved);const opts={sampleRate:PIPER_SAMPLE_RATE};return{buffer:buildWavBuffer(pcm,opts),mimeType:'audio/wav',extension:'wav'};}
  async function piperPreviewBuffer(voiceId){
    if(config.piperUrl){
      const response=await fetch(`${config.piperUrl}/voices/${encodeURIComponent(voiceId)}/preview`,{headers:piperAuthHeaders(),signal:signal(config.env.AUDIO_PROVIDER_TIMEOUT_MS||60_000,getCancellation)});
      if(!response.ok){const detail=await response.json().catch(()=>({}));throw new Error(detail.detail||`Piper preview failed (${response.status})`);}
      return Buffer.from(await response.arrayBuffer());
    }
    const pcm=await piperLineLocal('Hi there! This is a quick preview of this voice.',voiceId);
    return buildWavBuffer(pcm,{sampleRate:PIPER_SAMPLE_RATE});
  }
  function piperPreview(voiceId){
    const model=config.piperUrl?'piper-modal':'piper-local';
    const operation=async()=>{
      const buffer=await piperPreviewBuffer(voiceId);
      const seconds=buffer.length/AUDIO_BYTES_PER_SECOND.piper;
      return providerResult({output:buffer,provider:'piper',model,usage:{seconds},rawUsage:{bytes:buffer.length},measurementStatus:'observed'});
    };
    const tracked=()=>usageTracker?usageTracker.execute({modality:'audio',provider:'piper',model,inputMetadata:{voiceId,preview:true}},operation):operation();
    return providerAdmission?providerAdmission.run('piper',tracked,{signal:getCancellation?.()}):tracked();
  }
  async function elevenLine(text,voiceId){if(!config.env.ELEVENLABS_API_KEY)throw new Error('ELEVENLABS_API_KEY missing');const format=config.env.ELEVENLABS_OUTPUT_FORMAT||'pcm_24000';const response=await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(format)}`,{method:'POST',headers:{'Content-Type':'application/json','xi-api-key':config.env.ELEVENLABS_API_KEY},body:JSON.stringify({text,model_id:config.env.ELEVENLABS_MODEL_ID||'eleven_turbo_v2_5'}),signal:signal(config.env.AUDIO_PROVIDER_TIMEOUT_MS||60000,getCancellation)});if(!response.ok)await throwResponse('elevenlabs',response);return Buffer.from(await response.arrayBuffer());}
  async function elevenlabs(text,voice){if(!voice?.voiceId)throw new Error('No ElevenLabs narrator voice selected');const pcm=await elevenLine(text,voice.voiceId);return{buffer:buildWavBuffer(pcm),mimeType:'audio/wav',extension:'wav'};}
  async function sparkLine(text,voiceId){const headers={'Content-Type':'application/json'};if(config.sparkServiceToken)headers.Authorization=`Bearer ${config.sparkServiceToken}`;const response=await fetch(`${config.sparkUrl}/synthesize`,{method:'POST',headers,body:JSON.stringify({text,voiceId}),signal:signal(config.sparkTimeout,getCancellation)});if(!response.ok){const detail=await response.json().catch(()=>({}));throw new Error(detail.detail||`Voice cloning service error (${response.status})`);}return Buffer.from(await response.arrayBuffer());}
  async function spark(text,voice){if(!voice?.voiceId)throw new Error('No cloned narrator voice selected');const {pcm,...fmt}=parseWavPcm(await sparkLine(text,voice.voiceId));return{buffer:buildWavBuffer(pcm,fmt),mimeType:'audio/wav',extension:'wav'};}
  async function generate({provider,narrationText,voice}){
    const models={stub:'stub-audio-v1',piper:config.piperUrl?'piper-modal':'piper-local',spark:config.env.SPARK_MODEL||'spark-tts',elevenlabs:config.env.ELEVENLABS_MODEL_ID||'eleven_turbo_v2_5'};
    const characters=String(narrationText||'').length;
    const operation=async()=>{
      const output=await(provider==='stub'?stub(narrationText):provider==='piper'?piper(narrationText,voice):provider==='spark'?spark(narrationText,voice):elevenlabs(narrationText,voice));
      const seconds=AUDIO_BYTES_PER_SECOND[provider]?output.buffer.length/AUDIO_BYTES_PER_SECOND[provider]:undefined;
      return providerResult({output,provider,model:models[provider],usage:{characters,outputBytes:output.buffer.length,...(seconds!==undefined?{seconds}:{})},rawUsage:{characters},measurementStatus:provider==='stub'?'not_applicable':'observed'});
    };
    const tracked=()=>usageTracker?usageTracker.execute({modality:'audio',provider,model:models[provider],inputMetadata:{characters}},operation):operation();
    return provider!=='stub'&&providerAdmission?providerAdmission.run(provider,tracked,{signal:getCancellation?.()}):tracked();
  }
  return{generate,piperPreview};
}
module.exports={createAudioProviders};
