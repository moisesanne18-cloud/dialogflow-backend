// Complete index.js - Dialogflow KB + Groq LLM Enhancement
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
// MAIN ENDPOINT - Enhanced with Groq LLM
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

    // Step 2: Enhance answer if KB match exists
    if (knowledgeAnswers.length > 0) {
      const kbAnswer = knowledgeAnswers[0];
      const kbSnippet = kbAnswer.answer;
      const confidence = kbAnswer.matchConfidenceLevel || 'NO_MATCH';

      console.log(`🎯 Confidence level: ${confidence}`);

      // Only enhance MEDIUM or HIGH confidence matches
      if (confidence === CONFIDENCE_LEVELS.MEDIUM || confidence === CONFIDENCE_LEVELS.HIGH) {
        
        // Check if Groq API key is configured
        if (!GROQ_API_KEY) {
          console.warn('⚠️  GROQ_API_KEY not set - returning original KB text');
        } else {
          try {
            console.log('✨ Enhancing answer with Groq LLM...');
            
            const enhancedAnswer = await enhanceAnswerWithGroq(
              query,
              kbSnippet,
              confidence
            );

            if (enhancedAnswer && enhancedAnswer !== kbSnippet) {
              finalFulfillmentText = enhancedAnswer;
              console.log('✅ Answer enhanced successfully!');
            } else {
              console.log('📋 Using original KB text (enhancement returned same)');
            }

          } catch (groqError) {
            console.error('❌ Groq enhancement failed:', groqError.message);
            console.log('📋 Falling back to original KB text');
            // Fallback to original KB text
            finalFulfillmentText = kbSnippet;
          }
        }
      } else {
        console.log(`📋 Low confidence - using original KB text`);
        finalFulfillmentText = kbSnippet;
      }
    } else {
      console.log('ℹ️  No KB match - returning default response');
    }

    // Step 3: Return response to Flutter app
    res.json({
      queryText: result.queryText,
      detectedIntent: result.intent?.displayName || null,
      confidence: result.intentDetectionConfidence || 0,
      fulfillmentText: finalFulfillmentText, // This is now enhanced!
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
// GROQ LLM ENHANCEMENT FUNCTION
// ============================================================================
async function enhanceAnswerWithGroq(userQuery, kbSnippet, confidence) {
  // Create the anti-hallucination prompt
  const prompt = createAntiHallucinationPrompt(userQuery, kbSnippet, confidence);

  // Prepare Groq API request
  const requestData = {
    model: GROQ_MODEL,
    messages: [
      {
        role: 'system',
        content: 'You are GrowBot 🌿, a helpful gardening assistant. You answer questions using ONLY the provided knowledge base information. Never make up information or use general knowledge.'
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    temperature: 0.2,  // Low temperature = more factual, less creative
    max_tokens: 300,   // Keep responses concise
    top_p: 0.9,
    stream: false
  };

  try {
    const response = await makeGroqRequest(requestData);
    
    // Extract the enhanced answer
    const enhancedAnswer = response.choices[0].message.content.trim();
    
    // Basic validation
    if (!enhancedAnswer || enhancedAnswer.length < 10) {
      console.warn('⚠️  Enhanced answer too short, using original');
      return kbSnippet;
    }

    // Check for "I don't have" responses (LLM couldn't answer)
    if (enhancedAnswer.toLowerCase().includes("i don't have") ||
        enhancedAnswer.toLowerCase().includes("i cannot find")) {
      console.warn('⚠️  LLM says no info available, using original KB text');
      return kbSnippet;
    }

    return enhancedAnswer;

  } catch (error) {
    console.error('Groq API error:', error.message);
    // Return original KB snippet on error
    return kbSnippet;
  }
}

// ============================================================================
// ANTI-HALLUCINATION PROMPT TEMPLATE
// ============================================================================
function createAntiHallucinationPrompt(userQuery, kbSnippet, confidence) {
  return `You are answering a gardening question for GrowBot. Follow these rules STRICTLY:

🚫 STRICT RULES:
1. Answer ONLY using the SOURCE DOCUMENT below - nothing else!
2. If the answer is not in the source, say: "I don't have specific information about that in my knowledge base."
3. Do NOT add information from general knowledge or make assumptions
4. Do NOT infer or extrapolate beyond what's explicitly written
5. Keep your answer natural, conversational, and helpful
6. Make it 2-4 sentences maximum
7. Directly address the user's specific question

📄 SOURCE DOCUMENT (TRUTH):
────────────────────────────
${kbSnippet}
────────────────────────────

❓ USER'S QUESTION: "${userQuery}"

🎯 CONFIDENCE LEVEL: ${confidence}

✍️ YOUR TASK:
- Read the source document carefully
- Check if it contains the answer to the user's question
- If YES: Rewrite the relevant information in a clear, natural, conversational way that directly answers their question
- If NO: Say you don't have that specific information

💬 YOUR ANSWER (conversational tone, like texting a friend, 2-4 sentences):`;
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
    service: 'Dialogflow KB Backend with Groq LLM Enhancement 🌿',
    groqConfigured: !!GROQ_API_KEY,
    model: GROQ_MODEL,
    version: '2.0.0',
    endpoints: {
      detectIntent: 'POST /detectIntent',
      health: 'GET /'
    }
  });
});

// ============================================================================
// ADDITIONAL TEST ENDPOINT (Optional - for testing Groq directly)
// ============================================================================
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

// ============================================================================
// START SERVER
// ============================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('🌱 GrowBot Backend Server Started! 🌱');
  console.log('═══════════════════════════════════════════════════');
  console.log(`📡 Port: ${PORT}`);
  console.log(`🤖 Dialogflow Project: ${projectId}`);
  console.log(`📚 Knowledge Base ID: ${knowledgeBaseId}`);
  console.log(`✨ Groq API: ${GROQ_API_KEY ? '✅ Configured' : '❌ NOT CONFIGURED'}`);
  console.log(`🧠 Model: ${GROQ_MODEL}`);
  console.log('');
  console.log('📍 Endpoints:');
  console.log(`   GET  / (health check)`);
  console.log(`   POST /detectIntent (main endpoint)`);
  console.log(`   POST /test-groq (test Groq enhancement)`);
  console.log('═══════════════════════════════════════════════════');
  console.log('');
});
