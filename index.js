// Complete index.js - SMART HYBRID: Groq-First with KB Validation
// Web knowledge FIRST, then cross-check with KB
// For Render.com deployment

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const dialogflow = require('@google-cloud/dialogflow').v2beta1;
const https = require('https');

const app = express();
app.use(bodyParser.json());
app.use(cors());

// Dialogflow client
const sessionClient = new dialogflow.SessionsClient({
  keyFilename: 'service-account.json',
});

const projectId = 'digibot-qkf9';
const knowledgeBaseId = 'Njc5Njg3MDI3MDg3NjM4NTI5';

// Groq API Configuration
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'llama-3.1-8b-instant';

// Confidence levels
const CONFIDENCE_LEVELS = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  NO_MATCH: 'NO_MATCH'
};

// ============================================================================
// MASTER RULES FOR GROQ
// ============================================================================
const MASTER_RULES = `You are GrowBot 🌿, a friendly and knowledgeable gardening assistant.

CORE RULES:
1. Give direct, practical gardening advice
2. Keep answers SHORT: 2-4 sentences maximum
3. Be friendly and conversational
4. Never mention documents, confidence levels, or meta-analysis
5. Never say "the text says" or "according to..."
6. Focus on actionable tips gardeners can use immediately
7. Use simple language, avoid scientific jargon unless necessary
8. Be honest if you're unsure about something specific`;

// ============================================================================
// MAIN ENDPOINT - SMART HYBRID (Groq-First Strategy)
// ============================================================================
app.post('/detectIntent', async (req, res) => {
  try {
    const { sessionId, query, languageCode } = req.body;

    console.log(`\n📩 New query: "${query}"`);

    // ========================================================================
    // STEP 1: Get Groq Answer FIRST (Primary Source)
    // ========================================================================
    let groqAnswer = null;
    let groqSuccess = false;

    if (GROQ_API_KEY) {
      try {
        console.log('🌐 Getting Groq answer first...');
        groqAnswer = await getGroqAnswer(query);
        
        if (groqAnswer && groqAnswer.length > 10) {
          groqSuccess = true;
          console.log('✅ Groq answer retrieved successfully!');
        } else {
          console.log('⚠️  Groq answer too short or empty');
        }
      } catch (error) {
        console.error('❌ Groq failed:', error.message);
      }
    } else {
      console.warn('⚠️  GROQ_API_KEY not configured');
    }

    // ========================================================================
    // STEP 2: Check KB for Validation/Enhancement (Secondary)
    // ========================================================================
    let kbAnswer = null;
    let kbConfidence = 'NO_MATCH';
    let kbFound = false;

    try {
      console.log('📚 Checking KB for validation...');
      
      const sessionPath = sessionClient.projectAgentSessionPath(projectId, sessionId);
      const knowledgeBasePath = `projects/${projectId}/knowledgeBases/${knowledgeBaseId}`;

      const request = {
        session: sessionPath,
        queryInput: {
          text: {
            text: query,
            languageCode: languageCode || 'en-US',
          },
        },
        queryParams: {
          knowledgeBaseNames: [knowledgeBasePath],
        },
      };

      const responses = await sessionClient.detectIntent(request);
      const result = responses[0].queryResult;
      const knowledgeAnswers = result.knowledgeAnswers?.answers || [];

      if (knowledgeAnswers.length > 0) {
        const kbResult = knowledgeAnswers[0];
        kbAnswer = kbResult.answer;
        kbConfidence = kbResult.matchConfidenceLevel || 'NO_MATCH';
        kbFound = true;
        console.log(`✅ KB match found (${kbConfidence})`);
      } else {
        console.log('ℹ️  No KB match');
      }

    } catch (kbError) {
      console.error('❌ KB check failed:', kbError.message);
    }

    // ========================================================================
    // STEP 3: SMART DECISION LOGIC
    // ========================================================================
    let finalAnswer = '';
    let answerSource = '';

    if (groqSuccess && kbFound) {
      // CASE 1: Both Groq and KB available
      if (kbConfidence === CONFIDENCE_LEVELS.HIGH || kbConfidence === CONFIDENCE_LEVELS.MEDIUM) {
        // KB has high confidence → Enhance Groq with KB
        console.log('🎯 HIGH/MEDIUM KB confidence → Enhancing Groq with KB info');
        try {
          const enhanced = await enhanceGroqWithKB(query, groqAnswer, kbAnswer);
          finalAnswer = enhanced || groqAnswer;
          answerSource = 'groq_enhanced_by_kb';
        } catch (error) {
          console.error('Enhancement failed:', error.message);
          finalAnswer = groqAnswer;
          answerSource = 'groq_only';
        }
      } else {
        // KB has low confidence → Use pure Groq
        console.log('⚠️  LOW KB confidence → Using pure Groq answer');
        finalAnswer = groqAnswer;
        answerSource = 'groq_primary';
      }

    } else if (groqSuccess && !kbFound) {
      // CASE 2: Groq success, no KB → Use Groq
      console.log('🌐 No KB match → Using Groq answer');
      finalAnswer = groqAnswer;
      answerSource = 'groq_only';

    } else if (!groqSuccess && kbFound) {
      // CASE 3: Groq failed, KB available → Fallback to KB
      console.log('📚 Groq failed → Falling back to KB');
      if (kbConfidence === CONFIDENCE_LEVELS.HIGH || kbConfidence === CONFIDENCE_LEVELS.MEDIUM) {
        try {
          const enhanced = await enhanceKBAnswer(query, kbAnswer);
          finalAnswer = enhanced || kbAnswer;
          answerSource = 'kb_enhanced';
        } catch (error) {
          finalAnswer = kbAnswer;
          answerSource = 'kb_original';
        }
      } else {
        finalAnswer = kbAnswer;
        answerSource = 'kb_low_confidence';
      }

    } else {
      // CASE 4: Both failed → Default message
      console.log('❌ Both Groq and KB failed');
      finalAnswer = "I'm having trouble answering that right now. Could you try rephrasing your question about gardening? 🌱";
      answerSource = 'fallback';
    }

    // ========================================================================
    // STEP 4: Return Response
    // ========================================================================
    res.json({
      queryText: query,
      fulfillmentText: finalAnswer,
      answerSource: answerSource,
      metadata: {
        groqSuccess: groqSuccess,
        kbFound: kbFound,
        kbConfidence: kbConfidence
      }
    });

  } catch (err) {
    console.error('❌ BACKEND ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GROQ PRIMARY ANSWER (Main source of truth)
// ============================================================================
async function getGroqAnswer(userQuery) {
  const prompt = `You are GrowBot 🌿, an expert gardening assistant.

The user asked: "${userQuery}"

Provide a helpful, accurate answer about gardening.

REQUIREMENTS:
- Give practical, actionable advice
- Keep it 2-4 sentences
- Be friendly and conversational
- Focus on what works for most gardeners
- If it's not about gardening, politely redirect

Your answer:`;

  const requestData = {
    model: GROQ_MODEL,
    messages: [
      {
        role: 'system',
        content: MASTER_RULES
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    temperature: 0.4,
    max_tokens: 350,
    top_p: 0.9,
    stream: false
  };

  try {
    const response = await makeGroqRequest(requestData);
    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error('Groq primary answer failed:', error.message);
    throw error;
  }
}

// ============================================================================
// ENHANCE GROQ WITH KB (When KB has high confidence)
// ============================================================================
async function enhanceGroqWithKB(userQuery, groqAnswer, kbAnswer) {
  const prompt = `You are GrowBot 🌿.

The user asked: "${userQuery}"

You generated this answer:
────────────────────────────
${groqAnswer}
────────────────────────────

Additional verified information from knowledge base:
────────────────────────────
${kbAnswer}
────────────────────────────

TASK:
- Review your answer against the KB info
- If KB adds important details you missed, incorporate them naturally
- If KB contradicts you, prioritize KB info
- If KB doesn't add value, keep your original answer
- Keep it 2-4 sentences, conversational and helpful
- NEVER mention "knowledge base" or "according to"

Final enhanced answer:`;

  const requestData = {
    model: GROQ_MODEL,
    messages: [
      {
        role: 'system',
        content: MASTER_RULES
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    temperature: 0.3,
    max_tokens: 350,
    top_p: 0.9,
    stream: false
  };

  try {
    const response = await makeGroqRequest(requestData);
    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error('Enhancement failed:', error.message);
    throw error;
  }
}

// ============================================================================
// ENHANCE KB ANSWER (When Groq fails but KB exists)
// ============================================================================
async function enhanceKBAnswer(userQuery, kbAnswer) {
  const prompt = `You are GrowBot 🌿.

The user asked: "${userQuery}"

Knowledge base information:
────────────────────────────
${kbAnswer}
────────────────────────────

TASK:
- Rewrite this in a friendly, conversational way
- Keep it 2-4 sentences
- Make it practical and actionable
- NEVER mention "knowledge base" or "document"

Your answer:`;

  const requestData = {
    model: GROQ_MODEL,
    messages: [
      {
        role: 'system',
        content: MASTER_RULES
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    temperature: 0.2,
    max_tokens: 300,
    top_p: 0.9,
    stream: false
  };

  try {
    const response = await makeGroqRequest(requestData);
    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error('KB enhancement failed:', error.message);
    throw error;
  }
}

// ============================================================================
// HTTPS REQUEST TO GROQ API
// ============================================================================
function makeGroqRequest(requestData) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(requestData);

    const options = {
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const jsonResponse = JSON.parse(data);
            resolve(jsonResponse);
          } catch (e) {
            reject(new Error(`Failed to parse Groq response: ${e.message}`));
          }
        } else {
          reject(new Error(`Groq API error: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Request failed: ${error.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(postData);
    req.end();
  });
}

// ============================================================================
// HEALTH CHECK ENDPOINT
// ============================================================================
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    service: 'GrowBot - Smart Hybrid (Groq-First) 🌿',
    strategy: 'groq_first_kb_validation',
    groqConfigured: !!GROQ_API_KEY,
    model: GROQ_MODEL,
    version: '4.0.0-smart-hybrid',
    flowDescription: [
      '1. Get Groq answer FIRST (primary source)',
      '2. Check KB for validation (secondary)',
      '3. Enhance Groq with KB if KB has HIGH/MEDIUM confidence',
      '4. Use pure Groq if KB is LOW/NO_MATCH',
      '5. Fallback to KB only if Groq fails'
    ],
    benefits: [
      'Always fresh, accurate gardening info',
      'KB validates and enhances when confident',
      'Best of both worlds',
      'Faster responses (parallel checks possible)',
      'More reliable than KB-only'
    ],
    endpoints: {
      detectIntent: 'POST /detectIntent',
      testGroq: 'POST /test-groq-primary',
      testEnhancement: 'POST /test-enhancement',
      health: 'GET /'
    }
  });
});

// ============================================================================
// TEST ENDPOINTS
// ============================================================================

// Test pure Groq answer
app.post('/test-groq-primary', async (req, res) => {
  const { query } = req.body;

  if (!GROQ_API_KEY) {
    return res.status(400).json({ error: 'GROQ_API_KEY not configured' });
  }

  try {
    const answer = await getGroqAnswer(
      query || 'How do I prevent tomato blight?'
    );

    res.json({
      mode: 'groq_primary',
      query: query,
      answer: answer,
      success: true
    });

  } catch (error) {
    res.status(500).json({
      error: error.message,
      success: false
    });
  }
});

// Test Groq + KB enhancement
app.post('/test-enhancement', async (req, res) => {
  const { query, groqAnswer, kbAnswer } = req.body;

  if (!GROQ_API_KEY) {
    return res.status(400).json({ error: 'GROQ_API_KEY not configured' });
  }

  try {
    const enhanced = await enhanceGroqWithKB(
      query || 'How to grow tomatoes?',
      groqAnswer || 'Plant tomatoes in full sun and water regularly.',
      kbAnswer || 'Tomatoes need 6-8 hours of direct sunlight and consistent moisture.'
    );

    res.json({
      mode: 'groq_enhanced_by_kb',
      original: groqAnswer,
      kbInfo: kbAnswer,
      enhanced: enhanced,
      success: true
    });

  } catch (error) {
    res.status(500).json({
      error: error.message,
      success: false
    });
  }
});

// ============================================================================
// START SERVER
// ============================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('🌱 GrowBot Backend - SMART HYBRID MODE! 🌱');
  console.log('═══════════════════════════════════════════════════');
  console.log(`📡 Port: ${PORT}`);
  console.log(`🤖 Dialogflow Project: ${projectId}`);
  console.log(`📚 Knowledge Base ID: ${knowledgeBaseId}`);
  console.log(`✨ Groq API: ${GROQ_API_KEY ? '✅ Configured' : '❌ NOT CONFIGURED'}`);
  console.log(`🧠 Model: ${GROQ_MODEL}`);
  console.log('');
  console.log('🎯 Smart Hybrid Strategy:');
  console.log('   1️⃣  Get Groq answer FIRST (primary)');
  console.log('   2️⃣  Check KB for validation (secondary)');
  console.log('   3️⃣  Enhance with KB if HIGH/MEDIUM confidence');
  console.log('   4️⃣  Use pure Groq if KB is LOW/NO_MATCH');
  console.log('   5️⃣  Fallback to KB if Groq fails');
  console.log('');
  console.log('✅ Benefits:');
  console.log('   • Fresh, accurate info (Groq first)');
  console.log('   • KB validates when confident');
  console.log('   • Best of both worlds');
  console.log('   • Reliable fallback chain');
  console.log('');
  console.log('📍 Endpoints:');
  console.log(`   GET  / (health check)`);
  console.log(`   POST /detectIntent (main endpoint)`);
  console.log(`   POST /test-groq-primary (test Groq-first)`);
  console.log(`   POST /test-enhancement (test KB enhancement)`);
  console.log('═══════════════════════════════════════════════════');
  console.log('');
});
