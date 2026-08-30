// ─────────────────────────────────────────────
//  AI Analysis Service
//  Uses threshold-based scoring (works without API key)
//  + Optional Gemini API integration
// ─────────────────────────────────────────────
import type { AIAnalysisResult, SensorData, HospitalProfile, HospitalRecommendation } from '../types';

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || '';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

// ──────────────────────────────────────────────
//  Distress Keywords Dictionary
// ──────────────────────────────────────────────
export const DISTRESS_KEYWORDS = [
  'help', 'hospital', 'accident', 'emergency', 'ambulance',
  'doctor', 'pain', 'bleeding', 'blood', 'crash',
  'fell', 'fall', 'hurt', 'unconscious', 'save me',
  'cannot breathe', 'breathe', 'broken', 'stroke', 'chest pain'
];

export function extractDistressKeywords(text = ''): string[] {
  const lower = text.toLowerCase();
  return DISTRESS_KEYWORDS.filter(kw => lower.includes(kw));
}

// ──────────────────────────────────────────────
//  Emergency Confidence Scoring
//  Multimodal scoring:
//    1. Distress keywords (live transcribed audio) -> up to 35 pts
//    2. Audio vocalization / volume amplitude       -> up to 15 pts
//    3. Shake / impact magnitude                    -> up to 30 pts
//    4. Post-impact stillness                       -> up to 25 pts
//    5. Camera frame presence                       -> up to 10 pts
// ──────────────────────────────────────────────
const SHAKE_BASE     = 8;   // m/s² — base threshold for deliberate impact
const HIGH_THRESHOLD = 45;  // score required to classify HIGH

function computeLocalScore(sensor: SensorData): { score: number; reasoning: string; keywords: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // 1. Distress Speech / Voice Keywords
  const transcript = sensor.speechTranscript || '';
  const detectedKeywords = extractDistressKeywords(transcript);

  if (detectedKeywords.length > 0) {
    const kwPts = Math.min(35, detectedKeywords.length * 18);
    score += kwPts;
    reasons.push(`Distress keywords detected: "${detectedKeywords.join(', ').toUpperCase()}"`);
  } else if (transcript.trim().length > 0) {
    score += 10;
    reasons.push(`Voice activity recorded: "${transcript.slice(0, 40)}…"`);
  }

  // 2. Audio Level / Distress Vocalization
  if (sensor.audioLevel > 0.05) {
    const audioPts = Math.min(15, Math.round(sensor.audioLevel * 20));
    score += audioPts;
    if (sensor.audioLevel > 0.3) {
      reasons.push(`High acoustic energy / distress sound (${Math.round(sensor.audioLevel * 100)}%)`);
    }
  }

  // 3. Shake / Impact Magnitude
  if (sensor.maxShakeMagnitude >= SHAKE_BASE) {
    const shakePts = Math.min(30, Math.round(((sensor.maxShakeMagnitude - SHAKE_BASE) / 12) * 30 + 15));
    score += shakePts;
    reasons.push(`Impact acceleration: ${sensor.maxShakeMagnitude.toFixed(1)} m/s²`);
  } else if (sensor.maxShakeMagnitude > 3) {
    score += 10;
  }

  // 4. Post-Impact Stillness
  if (sensor.stillnessDuration > 0.5) {
    const stillPts = Math.min(25, Math.round((sensor.stillnessDuration / 3) * 25));
    score += Math.max(12, stillPts);
    reasons.push(`${sensor.stillnessDuration.toFixed(1)}s post-crash stillness`);
  }

  // 5. Camera capture visual context bonus
  if (sensor.cameraCapture) {
    score += 10;
    reasons.push('Scene frame captured');
  }

  const finalScore = Math.min(99, Math.max(15, Math.round(score)));
  const explanation = reasons.length > 0
    ? reasons.join(' • ')
    : `Readings: shake ${sensor.maxShakeMagnitude.toFixed(1)} m/s², audio ${Math.round(sensor.audioLevel * 100)}%`;

  return { score: finalScore, reasoning: explanation, keywords: detectedKeywords };
}

export async function analyseEmergency(sensor: SensorData): Promise<AIAnalysisResult> {
  const localAnalysis = computeLocalScore(sensor);
  sensor.distressKeywords = localAnalysis.keywords;

  // Try Gemini 1.5 Multimodal if API key is provided
  if (GEMINI_API_KEY && GEMINI_API_KEY !== 'YOUR_GEMINI_KEY') {
    try {
      const promptText = `You are a real-time Emergency Triage AI assistant (VitalSync). Analyze this incident telemetry and classify the emergency.

Telemetry:
- Transcribed Voice / Speech: "${sensor.speechTranscript || 'No speech transcribed'}"
- Distress Keywords Detected: ${localAnalysis.keywords.join(', ') || 'None'}
- Max Impact Magnitude: ${sensor.maxShakeMagnitude.toFixed(1)} m/s²
- Post-Impact Stillness Duration: ${sensor.stillnessDuration.toFixed(1)} seconds
- Ambient Audio Energy: ${(sensor.audioLevel * 100).toFixed(0)}%
- Visual Capture: ${sensor.cameraCapture ? 'Camera snapshot attached' : 'No camera snapshot'}

Analyze distress vocalizations (shouts for help, mentions of hospital/accident), stillness suggesting immobilization or unconsciousness, impact severity, and visual environment (e.g. fallen posture, trauma signs, road/vehicle ambience).

Respond ONLY with a JSON object in this exact format:
{
  "classification": "HIGH" or "LOW",
  "confidenceScore": <integer between 0 and 100>,
  "reasoning": "<concise clinical assessment in one or two sentences>"
}`;

      const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [
        { text: promptText },
      ];

      if (sensor.cameraCapture) {
        parts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: sensor.cameraCapture.replace(/^data:image\/\w+;base64,/, ''),
          },
        });
      }

      const response = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }] }),
      });

      const data = await response.json();
      const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          classification:  (parsed.classification === 'HIGH' || parsed.classification === 'LOW') ? parsed.classification : 'HIGH',
          confidenceScore: Number(parsed.confidenceScore) || localAnalysis.score,
          reasoning:       parsed.reasoning || localAnalysis.reasoning,
          timestamp:       Date.now(),
        };
      }
    } catch {
      // Fallback to enhanced local scoring
    }
  }

  // ── Enhanced Local Fallback ──────────
  return {
    classification:  localAnalysis.score >= HIGH_THRESHOLD ? 'HIGH' : 'LOW',
    confidenceScore: localAnalysis.score,
    reasoning:       localAnalysis.reasoning,
    timestamp:       Date.now(),
  };
}

// ──────────────────────────────────────────────
//  Hospital Recommendation
// ──────────────────────────────────────────────
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R  = 6371;
  const dL = ((lat2 - lat1) * Math.PI) / 180;
  const dN = ((lng2 - lng1) * Math.PI) / 180;
  const a  =
    Math.sin(dL / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dN / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function recommendHospitals(
  fromLat: number,
  fromLng: number,
  hospitals: HospitalProfile[],
  patientCondition = '',
): HospitalRecommendation[] {
  return hospitals
    .map((h) => {
      const distKm     = haversineKm(fromLat, fromLng, h.location.lat, h.location.lng);
      const etaMinutes = Math.round((distKm / 40) * 60); // avg 40 km/h city speed
      const reasons: string[] = [];
      let score = 0;

      // Distance score (max 30)
      const distScore = Math.max(0, 30 - distKm * 3);
      score += distScore;

      // Bed availability (max 25)
      const bedAvail = h.beds.emergency.available + h.beds.icu.available;
      if (bedAvail > 5) { score += 25; reasons.push(`${bedAvail} beds available`); }
      else if (bedAvail > 0) { score += 10; reasons.push(`${bedAvail} beds available`); }
      else reasons.push('⚠️ Beds limited');

      // Specialty match (max 20)
      const condLower = patientCondition.toLowerCase();
      const matched = h.specialties.filter(
        s => condLower.includes(s.toLowerCase()) || condLower === ''
      );
      if (matched.length > 0) { score += 20; reasons.push(`Specialty: ${matched.join(', ')}`); }

      // Oxygen availability (max 15)
      if (h.oxygen.cylinders > 10) { score += 15; reasons.push('Oxygen available'); }
      else if (h.oxygen.cylinders > 0) { score += 8; }

      // Distance label
      reasons.unshift(`${distKm.toFixed(1)} km away (~${etaMinutes} min)`);

      return { hospital: h, score: Math.round(score), distanceKm: distKm, etaMinutes, reasons };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}
