// Complete index.js - Dialogflow KB + Groq LLM Enhancement (IMPROVED HYBRID)
// With ZERO meta-commentary and clean output rules
// For Render.com deployment

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const dialogflow = require('@google-cloud/dialogflow').v2beta1;
const https = require('https'); // For Groq API calls

const app = express();
app.use(bodyParser.json());
app.use(cors()); // Allow all origins

// Dialogflow client
const sessionClient = new dialogflow.SessionsClient({
  keyFilename: 'service-account.json',
});

const projectId = 'digibot-qkf9';
const knowledgeBaseId = 'Njc5Njg3MDI3MDg3NjM4NTI5';

// Groq API Configuration
const GROQ_API_KEY = process.env.GROQ_API_KEY; // Set this in Render dashboard
const GROQ_MODEL = 'llama-3.1-8b-instant'; // Fast and accurate

// Confidence levels
const CONFIDENCE_LEVELS = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  NO_MATCH: 'NO_MATCH'
};

// ============================================================================
// MASTER RULES FOR GROQ (Applied to ALL modes)
// ============================================================================
const MASTER_RULES = `You are GrowBot 🌿, a friendly gardening assistant.

You follow these strict rules:

1. NEVER mention confidence levels, document relevance, or that something is not the main topic.
2. NEVER analyze the document like a researcher.
3. NEVER say "the text says…" or "based on the document…"
4. NEVER include long explanations. Keep the answer short and helpful.
5. ALWAYS answer the user's question FIRST, in a clean sentence.
6. ALWAYS be honest if the KB lacks specific information.
7. If KB is incomplete → add helpful general gardening advice.
8. Do NOT invent specific facts not widely accepted in gardening.
9. DO NOT write like an academic. Be friendly and practical.
10. KEEP ANSWERS: 2–4 sentences total.`;

// ============================================================================
// MAIN ENDPOINT - Enhanced with Improved Hybrid Groq LLM
// ============================================================================
app.post('/detectIntent', async (req, res) => {
  try {
    const { sessionId, query, languageCode } = req.body;

    console.log(`\n📩 New query: "${query}"`);

    // Step 1: Call Dialogflow Knowledge Base
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
    console.log(`📚 KB matches found: ${knowledgeAnswers.length}`);

    let finalFulfillmentText = result.fulfillmentText;
    let answerSource = 'default'; // Track where answer came from

    // Step 2: Improved Hybrid Enhancement Logic
    if (knowledgeAnswers.length > 0) {
      const kbAnswer = knowledgeAnswers[0];
      const kbSnippet = kbAnswer.answer;
      const confidence = kbAnswer.matchConfidenceLevel || 'NO_MATCH';

      console.log(`🎯 Confidence level: ${confidence}`);

      // Check if Groq API key is configured
      if (!GROQ_API_KEY) {
        console.warn('⚠️  GROQ_API_KEY not set - returning original KB text');
        finalFulfillmentText = kbSnippet;
        answerSource = 'kb_only';
      } else {
        try {
          if (confidence === CONFIDENCE_LEVELS.HIGH || confidence === CONFIDENCE_LEVELS.MEDIUM) {
            // HIGH/MEDIUM confidence → Strict KB-only enhancement
            console.log('✨ HIGH/MEDIUM confidence - strict KB enhancement...');
            
            const enhancedAnswer = await enhanceAnswerWithGroq(
              query,
              kbSnippet,
              confidence
            );

            if (enhancedAnswer && enhancedAnswer !== kbSnippet) {
              finalFulfillmentText = enhancedAnswer;
              answerSource = 'kb_enhanced';
              console.log('✅ Answer enhanced successfully (KB-only)!');
            } else {
              finalFulfillmentText = kbSnippet;
              answerSource = 'kb_original';
              console.log('📋 Using original KB text');
            }

          } else if (confidence === CONFIDENCE_LEVELS.LOW) {
            // LOW confidence → Try improved hybrid approach
            console.log('⚠️  LOW confidence - attempting improved hybrid answer...');
            
            const hybridAnswer = await handleLowConfidenceWithGroq(query, kbSnippet);
            
            if (hybridAnswer) {
              finalFulfillmentText = hybridAnswer;
              answerSource = 'hybrid';
              console.log('✅ Improved hybrid answer generated!');
            } else {
              finalFulfillmentText = kbSnippet;
              answerSource = 'kb_fallback';
              console.log('📋 Hybrid failed - using KB text');
            }

          } else {
            // NO_MATCH → Use KB snippet as fallback
            console.log('❌ NO_MATCH - using KB fallback');
            finalFulfillmentText = kbSnippet;
            answerSource = 'kb_no_match';
          }

        } catch (groqError) {
          console.error('❌ Groq enhancement failed:', groqError.message);
          console.log('📋 Falling back to original KB text');
          finalFulfillmentText = kbSnippet;
          answerSource = 'kb_error_fallback';
        }
      }

    } else {
      // No KB match at all → Try improved general knowledge
      console.log('❓ No KB match found - attempting general knowledge answer...');
      
      if (GROQ_API_KEY) {
        try {
          const generalAnswer = await handleNoKBMatchWithGroq(query);
          
          if (generalAnswer) {
            finalFulfillmentText = generalAnswer;
            answerSource = 'general_knowledge';
            console.log('✅ General knowledge answer generated!');
          } else {
            finalFulfillmentText = "I'm not sure about that specific topic. Could you rephrase your question or ask about something else related to gardening? 🌱";
            answerSource = 'default_fallback';
            console.log('❌ No answer possible - using default fallback');
          }
        } catch (error) {
          console.error('❌ General knowledge query failed:', error.message);
          finalFulfillmentText = "I'm having trouble answering that right now. Could you try asking in a different way? 🌱";
          answerSource = 'error_fallback';
        }
      } else {
        finalFulfillmentText = "I don't have information about that in my knowledge base. Try asking about plant care, watering, or common gardening topics! 🌱";
        answerSource = 'no_groq_fallback';
      }
    }

    // Step 3: Return response to Flutter app
    res.json({
      queryText: result.queryText,
      detectedIntent: result.intent?.displayName || null,
      confidence: result.intentDetectionConfidence || 0,
      fulfillmentText: finalFulfillmentText,
      answerSource: answerSource, // Helps with debugging
      knowledgeAnswers: knowledgeAnswers.map(a => ({
        answer: a.answer,
        matchConfidence: a.matchConfidence,
        matchConfidenceLevel: a.matchConfidenceLevel,
      })),
    });

  } catch (err) {
    console.error('❌ BACKEND ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// STRICT KB-ONLY ENHANCEMENT (for HIGH/MEDIUM confidence)
// ============================================================================
async function enhanceAnswerWithGroq(userQuery, kbSnippet, confidence) {
  const prompt = `You are GrowBot 🌿, a friendly gardening assistant. Follow these rules STRICTLY:

🚫 STRICT RULES:
1. Answer ONLY using the SOURCE DOCUMENT below - nothing else!
2. If the answer is not in the source, say: "I don't have specific information about that in my knowledge base."
3. Do NOT add information from general knowledge or make assumptions
4. Do NOT infer or extrapolate beyond what's explicitly written
5. Keep your answer natural, conversational, and helpful
6. Make it 2-4 sentences maximum
7. Directly address the user's specific question
8. NEVER mention confidence levels or document analysis
9. NEVER say "the text says" or "according to the document"
10. Just give the answer cleanly and directly

📄 SOURCE DOCUMENT (TRUTH):
────────────────────────────
${kbSnippet}
────────────────────────────

❓ USER'S QUESTION: "${userQuery}"

💬 YOUR ANSWER (conversational, friendly, 2-4 sentences):`;

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
    temperature: 0.2,  // Low temperature = more factual
    max_tokens: 300,
    top_p: 0.9,
    stream: false
  };

  try {
    const response = await makeGroqRequest(requestData);
    const enhancedAnswer = response.choices[0].message.content.trim();
    
    // Basic validation
    if (!enhancedAnswer || enhancedAnswer.length < 10) {
      console.warn('⚠️  Enhanced answer too short, using original');
      return kbSnippet;
    }

    // Check for "I don't have" responses
    if (enhancedAnswer.toLowerCase().includes("i don't have") ||
        enhancedAnswer.toLowerCase().includes("i cannot find")) {
      console.warn('⚠️  LLM says no info available, using original KB text');
      return kbSnippet;
    }

    return enhancedAnswer;

  } catch (error) {
    console.error('Groq API error:', error.message);
    return kbSnippet;
  }
}

// ============================================================================
// IMPROVED HYBRID APPROACH (for LOW confidence - KB + General Knowledge)
// ============================================================================
async function handleLowConfidenceWithGroq(userQuery, kbSnippet) {
  const hybridPrompt = `You are GrowBot 🌿, a friendly gardening assistant.

The user asked: "${userQuery}"

Below is partial or incomplete information from the knowledge base:
────────────────────────────
${kbSnippet}
────────────────────────────

Your task:
- Give a clean and direct answer to the user.
- Do NOT reference or analyze the KB.
- If the KB info is incomplete, add 1–2 helpful general gardening tips.
- If the KB info does not answer the question directly, simply give general gardening advice related to the topic.
- NEVER mention that the document is incomplete or unrelated.
- NEVER mention confidence levels or document matching.
- NEVER say things like "aphids aren't the main topic" or analyze the document.
- Keep the answer short (2–4 sentences), friendly, and practical.
- Start with the answer immediately, no meta commentary.

Your final answer:`;

  const requestData = {
    model: GROQ_MODEL,
    messages: [
      {
        role: 'system',
        content: MASTER_RULES
      },
      {
        role: 'user',
        content: hybridPrompt
      }
    ],
    temperature: 0.4,  // Slightly higher for general knowledge
    max_tokens: 350,
    top_p: 0.9,
    stream: false
  };

  try {
    const response = await makeGroqRequest(requestData);
    const answer = response.choices[0].message.content.trim();
    
    if (!answer || answer.length < 10) {
      return null;
    }
    
    return answer;

  } catch (error) {
    console.error('Hybrid approach failed:', error.message);
    return null;
  }
}

// ============================================================================
// IMPROVED GENERAL KNOWLEDGE FALLBACK (for NO KB match at all)
// ============================================================================
async function handleNoKBMatchWithGroq(userQuery) {
  const generalPrompt = `You are GrowBot 🌿, a friendly gardening assistant.

The user asked: "${userQuery}"

There is no information about this in the knowledge base.

Your task:
- Be honest about that in ONE short sentence.
- Then provide 1–2 practical general gardening tips related to the question.
- Keep the tone friendly, helpful, and simple.
- Avoid unnecessary details or scientific jargon.
- Never produce long explanations.
- NEVER mention confidence levels or document analysis.
- Just be helpful and direct.

Example format:
"I don't have specific info about that in my knowledge base. [Then 1-2 helpful tips]"

Your final answer:`;

  const requestData = {
    model: GROQ_MODEL,
    messages: [
      {
        role: 'system',
        content: MASTER_RULES
      },
      {
        role: 'user',
        content: generalPrompt
      }
    ],
    temperature: 0.5,  // Moderate creativity for general advice
    max_tokens: 350,
    top_p: 0.9,
    stream: false
  };

  try {
    const response = await makeGroqRequest(requestData);
    const answer = response.choices[0].message.content.trim();
    
    if (!answer || answer.length < 10) {
      return null;
    }
    
    return answer;

  } catch (error) {
    console.error('General knowledge query failed:', error.message);
    return null;
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
      timeout: 10000 // 10 second timeout
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
    service: 'Dialogflow KB Backend with Improved Hybrid Groq Enhancement 🌿',
    approach: 'improved_hybrid',
    groqConfigured: !!GROQ_API_KEY,
    model: GROQ_MODEL,
    version: '3.1.0-improved',
    features: {
      highConfidence: 'Strict KB-only enhancement (zero meta-commentary)',
      mediumConfidence: 'Strict KB-only enhancement (zero meta-commentary)',
      lowConfidence: 'Improved Hybrid (KB + General, clean output)',
      noMatch: 'General gardening knowledge (honest + helpful)'
    },
    improvements: [
      'Zero meta-commentary about documents or confidence',
      'No academic analysis tone',
      'Clean, direct answers only',
      'Short responses (2-4 sentences)',
      'Friendly and practical',
      'Honest when KB lacks info'
    ],
    endpoints: {
      detectIntent: 'POST /detectIntent',
      testGroq: 'POST /test-groq',
      testHybrid: 'POST /test-hybrid',
      testGeneral: 'POST /test-general',
      health: 'GET /'
    }
  });
});

// ============================================================================
// TEST ENDPOINTS
// ============================================================================

// Test strict KB-only enhancement
app.post('/test-groq', async (req, res) => {
  const { query, kbText } = req.body;

  if (!GROQ_API_KEY) {
    return res.status(400).json({ error: 'GROQ_API_KEY not configured' });
  }

  try {
    const enhanced = await enhanceAnswerWithGroq(
      query || 'How to grow tomatoes?',
      kbText || 'Tomatoes need full sun and regular watering.',
      'HIGH'
    );

    res.json({
      mode: 'strict_kb_only',
      original: kbText,
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

// Test improved hybrid approach
app.post('/test-hybrid', async (req, res) => {
  const { query, kbText } = req.body;

  if (!GROQ_API_KEY) {
    return res.status(400).json({ error: 'GROQ_API_KEY not configured' });
  }

  try {
    const hybrid = await handleLowConfidenceWithGroq(
      query || 'How to deal with aphids?',
      kbText || 'Aphids are small insects that can damage plants.'
    );

    res.json({
      mode: 'improved_hybrid',
      original: kbText,
      enhanced: hybrid,
      success: true
    });

  } catch (error) {
    res.status(500).json({
      error: error.message,
      success: false
    });
  }
});

// Test general knowledge (no KB)
app.post('/test-general', async (req, res) => {
  const { query } = req.body;

  if (!GROQ_API_KEY) {
    return res.status(400).json({ error: 'GROQ_API_KEY not configured' });
  }

  try {
    const general = await handleNoKBMatchWithGroq(
      query || 'What are the benefits of composting?'
    );

    res.json({
      mode: 'general_knowledge',
      query: query,
      answer: general,
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
  console.log('🌱 GrowBot Backend Server Started (IMPROVED)! 🌱');
  console.log('═══════════════════════════════════════════════════');
  console.log(`📡 Port: ${PORT}`);
  console.log(`🤖 Dialogflow Project: ${projectId}`);
  console.log(`📚 Knowledge Base ID: ${knowledgeBaseId}`);
  console.log(`✨ Groq API: ${GROQ_API_KEY ? '✅ Configured' : '❌ NOT CONFIGURED'}`);
  console.log(`🧠 Model: ${GROQ_MODEL}`);
  console.log('');
  console.log('🎯 Improved Hybrid Strategy:');
  console.log('   ✅ HIGH/MEDIUM → Strict KB-only (clean output)');
  console.log('   ✅ LOW → Improved Hybrid (no meta-commentary)');
  console.log('   ✅ NO MATCH → General Knowledge (honest + helpful)');
  console.log('');
  console.log('🔥 Key Improvements:');
  console.log('   • Zero meta-commentary about documents');
  console.log('   • No academic analysis tone');
  console.log('   • Clean, direct answers only');
  console.log('   • Short responses (2-4 sentences)');
  console.log('   • Honest when KB lacks info');
  console.log('');
  console.log('📍 Endpoints:');
  console.log(`   GET  / (health check)`);
  console.log(`   POST /detectIntent (main endpoint)`);
  console.log(`   POST /test-groq (test KB-only)`);
  console.log(`   POST /test-hybrid (test improved hybrid)`);
  console.log(`   POST /test-general (test general knowledge)`);
  console.log('═══════════════════════════════════════════════════');
  console.log('');
});
