// Complete index.js - Dialogflow KB + Groq LLM + FCM NOTIFICATIONS
// OPTIMIZED FOR FREE TIER RENDER - WITH KEEP-ALIVE & CACHING

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const dialogflow = require('@google-cloud/dialogflow').v2beta1;
const admin = require('firebase-admin');
const https = require('https');
const axios = require('axios'); // ✅ NEW: For keep-alive ping

const app = express();
app.use(bodyParser.json());
app.use(cors());

// ============================================================================
// FIREBASE ADMIN INITIALIZATION - DUAL SERVICE ACCOUNTS
// ============================================================================

let chatbotApp;
let fcmApp;

try {
  // 1️⃣ Initialize for CHATBOT (digibot-qkf9)
  const chatbotServiceAccount = require('./service-account.json');
  chatbotApp = admin.initializeApp({
    credential: admin.credential.cert(chatbotServiceAccount),
    projectId: 'digibot-qkf9'
  }, 'chatbot');
  
  console.log('✅ Chatbot Firebase initialized (digibot-qkf9)');
} catch (error) {
  console.error('❌ Failed to initialize Chatbot Firebase:', error.message);
}

try {
  // 2️⃣ Initialize for FCM NOTIFICATIONS (digisproutapp)
  const fcmServiceAccount = require('./digisproutapp-service-account.json');
  fcmApp = admin.initializeApp({
    credential: admin.credential.cert(fcmServiceAccount),
    projectId: 'digisproutapp'
  }, 'fcm');
  
  console.log('✅ FCM Firebase initialized (digisproutapp)');
} catch (error) {
  console.error('❌ Failed to initialize FCM Firebase:', error.message);
  console.error('⚠️  Make sure digisproutapp-service-account.json exists!');
}

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
// ✅ NEW: RESPONSE CACHE (For faster repeated queries)
// ============================================================================
const responseCache = new Map();
const CACHE_DURATION = 1000 * 60 * 30; // 30 minutes

function getCachedResponse(query) {
  const cacheKey = query.toLowerCase().trim();
  const cached = responseCache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
    console.log(`[CACHE HIT] ${cacheKey}`);
    return cached.response;
  }
  return null;
}

function setCachedResponse(query, response) {
  const cacheKey = query.toLowerCase().trim();
  responseCache.set(cacheKey, {
    response,
    timestamp: Date.now()
  });
  
  // Cleanup old cache (limit to 100 entries)
  if (responseCache.size > 100) {
    const now = Date.now();
    for (const [key, value] of responseCache.entries()) {
      if (now - value.timestamp > CACHE_DURATION) {
        responseCache.delete(key);
      }
    }
  }
}

// ============================================================================
// ✅ NEW: KEEP-ALIVE PING ENDPOINT (Prevents cold start)
// ============================================================================
app.get('/ping', (req, res) => {
  res.status(200).json({ 
    status: 'alive', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    cache_size: responseCache.size
  });
});

// ============================================================================
// 🔔 FCM NOTIFICATION ENDPOINT - OPTIMIZED (No logic changes)
// ============================================================================
app.post('/send-chat-notification', async (req, res) => {
  const startTime = Date.now(); // ✅ Track response time
  
  try {
    const { 
      recipientToken,
      senderName,
      messageText,
      chatRoomId,
      postTitle
    } = req.body;

    console.log(`\n🔔 Sending notification to ${senderName}`);

    if (!fcmApp) {
      console.error('❌ FCM app not initialized!');
      return res.status(500).json({ 
        success: false, 
        error: 'FCM service not available - check digisproutapp-service-account.json' 
      });
    }

    if (!recipientToken || !senderName || !messageText) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: recipientToken, senderName, messageText' 
      });
    }

    const message = {
      notification: {
        title: senderName,
        body: messageText.length > 100 
          ? messageText.substring(0, 97) + '...' 
          : messageText,
      },
      data: {
        chatRoomId: chatRoomId || '',
        postTitle: postTitle || '',
        senderName: senderName,
        type: 'chat_message',
        clickAction: 'FLUTTER_NOTIFICATION_CLICK',
      },
      token: recipientToken,
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'chat_messages',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    };

    const response = await admin.messaging(fcmApp).send(message);
    
    const responseTime = Date.now() - startTime; // ✅ Calculate time
    console.log(`✅ Notification sent in ${responseTime}ms:`, response);
    
    res.json({ 
      success: true, 
      messageId: response,
      timestamp: new Date().toISOString(),
      project: 'digisproutapp',
      responseTime: `${responseTime}ms` // ✅ Return response time
    });

  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.error('❌ FCM notification error:', error);
    
    if (error.code === 'messaging/invalid-registration-token' ||
        error.code === 'messaging/registration-token-not-registered') {
      res.status(404).json({ 
        success: false, 
        error: 'Invalid or expired FCM token',
        code: error.code,
        responseTime: `${responseTime}ms`
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: error.message,
        code: error.code || 'unknown',
        responseTime: `${responseTime}ms`
      });
    }
  }
});

// ============================================================================
// 🔔 BATCH NOTIFICATION ENDPOINT - OPTIMIZED (No logic changes)
// ============================================================================
app.post('/send-batch-notifications', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { notifications } = req.body;

    if (!fcmApp) {
      return res.status(500).json({ 
        success: false, 
        error: 'FCM service not available' 
      });
    }

    if (!Array.isArray(notifications) || notifications.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'notifications must be a non-empty array' 
      });
    }

    const messages = notifications.map(notif => ({
      notification: {
        title: notif.senderName,
        body: notif.messageText,
      },
      data: {
        chatRoomId: notif.chatRoomId || '',
        postTitle: notif.postTitle || '',
        type: 'chat_message',
      },
      token: notif.recipientToken,
    }));

    const response = await admin.messaging(fcmApp).sendEach(messages);
    
    const responseTime = Date.now() - startTime;
    console.log(`✅ Sent ${response.successCount}/${notifications.length} notifications in ${responseTime}ms`);
    
    res.json({ 
      success: true, 
      successCount: response.successCount,
      failureCount: response.failureCount,
      responses: response.responses,
      project: 'digisproutapp',
      responseTime: `${responseTime}ms`
    });

  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.error('❌ Batch notification error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      responseTime: `${responseTime}ms`
    });
  }
});

// ============================================================================
// MAIN CHATBOT ENDPOINT - OPTIMIZED WITH CACHING (All logic retained)
// ============================================================================
app.post('/detectIntent', async (req, res) => {
  const startTime = Date.now(); // ✅ Track response time
  
  try {
    const { sessionId, query, languageCode } = req.body;

    console.log(`\n📩 New query: "${query}"`);

    // ✅ Check cache first
    const cachedResult = getCachedResponse(query);
    if (cachedResult) {
      const responseTime = Date.now() - startTime;
      console.log(`✅ Returning cached response in ${responseTime}ms`);
      return res.json({
        ...cachedResult,
        cached: true,
        responseTime: `${responseTime}ms`
      });
    }

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
    let answerSource = 'default';

    if (knowledgeAnswers.length > 0) {
      const kbAnswer = knowledgeAnswers[0];
      const kbSnippet = kbAnswer.answer;
      const confidence = kbAnswer.matchConfidenceLevel || 'NO_MATCH';

      console.log(`🎯 Confidence level: ${confidence}`);

      if (!GROQ_API_KEY) {
        console.warn('⚠️  GROQ_API_KEY not set - returning original KB text');
        finalFulfillmentText = kbSnippet;
        answerSource = 'kb_only';
      } else {
        try {
          if (confidence === CONFIDENCE_LEVELS.HIGH || confidence === CONFIDENCE_LEVELS.MEDIUM) {
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
            console.log('⚠️  LOW confidence - attempting hybrid answer...');
            
            const hybridAnswer = await handleLowConfidenceWithGroq(query, kbSnippet);
            
            if (hybridAnswer) {
              finalFulfillmentText = hybridAnswer;
              answerSource = 'hybrid';
              console.log('✅ Hybrid answer generated!');
            } else {
              finalFulfillmentText = kbSnippet;
              answerSource = 'kb_fallback';
              console.log('📋 Hybrid failed - using KB text');
            }

          } else {
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

    const responseTime = Date.now() - startTime;
    console.log(`✅ Response generated in ${responseTime}ms`);

    const responseData = {
      queryText: result.queryText,
      detectedIntent: result.intent?.displayName || null,
      confidence: result.intentDetectionConfidence || 0,
      fulfillmentText: finalFulfillmentText,
      answerSource: answerSource,
      knowledgeAnswers: knowledgeAnswers.map(a => ({
        answer: a.answer,
        matchConfidence: a.matchConfidence,
        matchConfidenceLevel: a.matchConfidenceLevel,
      })),
      cached: false,
      responseTime: `${responseTime}ms` // ✅ Return response time
    };

    // ✅ Cache the response
    setCachedResponse(query, responseData);

    res.json(responseData);

  } catch (err) {
    const responseTime = Date.now() - startTime;
    console.error('❌ BACKEND ERROR:', err);
    res.status(500).json({ 
      error: err.message,
      responseTime: `${responseTime}ms`
    });
  }
});

// ============================================================================
// GROQ ENHANCEMENT FUNCTIONS - OPTIMIZED (All logic retained)
// ============================================================================

async function enhanceAnswerWithGroq(userQuery, kbSnippet, confidence) {
  const prompt = createAntiHallucinationPrompt(userQuery, kbSnippet, confidence);

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
    temperature: 0.2,
    max_tokens: 150, // ✅ Optimized for speed
    top_p: 0.9,
    stream: false
  };

  try {
    const response = await makeGroqRequest(requestData);
    const enhancedAnswer = response.choices[0].message.content.trim();
    
    if (!enhancedAnswer || enhancedAnswer.length < 10) {
      console.warn('⚠️  Enhanced answer too short, using original');
      return kbSnippet;
    }

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

async function handleLowConfidenceWithGroq(userQuery, kbSnippet) {
  const hybridPrompt = `You are GrowBot 🌿, a gardening assistant.

SITUATION: The user asked about "${userQuery}"
Our knowledge base has LIMITED information about this.

SOURCE INFO (incomplete or partially relevant):
────────────────────────────
${kbSnippet}
────────────────────────────

YOUR TASK:
1. Read the source info carefully
2. If it partially answers the question → Use it and supplement with general gardening knowledge
3. Keep your answer practical and actionable (2-4 sentences)
4. If using general knowledge, briefly mention it's based on general practices

RULES:
- Prioritize source info when available
- Add helpful general advice to make the answer complete
- Be conversational and friendly
- Focus on practical, actionable guidance

YOUR ANSWER:`;

  const requestData = {
    model: GROQ_MODEL,
    messages: [
      {
        role: 'system',
        content: 'You are GrowBot, a knowledgeable gardening assistant. Provide helpful, accurate gardening advice by combining available source info with general knowledge.'
      },
      {
        role: 'user',
        content: hybridPrompt
      }
    ],
    temperature: 0.4,
    max_tokens: 250, // ✅ Reduced for speed
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

async function handleNoKBMatchWithGroq(userQuery) {
  const generalPrompt = `You are GrowBot 🌿, a gardening assistant.

The user asked: "${userQuery}"

We don't have specific information about this in our knowledge base.

YOUR TASK:
- Provide helpful general gardening advice based on your knowledge
- Keep it practical and actionable (2-3 sentences)
- Mention this is general gardening advice
- If the topic is outside gardening, politely redirect to gardening topics

RULES:
- Be honest about using general knowledge
- Focus on safe, widely-accepted practices
- Keep it conversational and friendly
- If unsure, recommend consulting a local expert

YOUR ANSWER:`;

  const requestData = {
    model: GROQ_MODEL,
    messages: [
      {
        role: 'system',
        content: 'You are GrowBot, a helpful gardening assistant. Provide general gardening advice when specific knowledge base info is unavailable.'
      },
      {
        role: 'user',
        content: generalPrompt
      }
    ],
    temperature: 0.5,
    max_tokens: 250, // ✅ Reduced for speed
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
      timeout: 8000 // ✅ Reduced timeout for faster failures
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
// HEALTH CHECK ENDPOINT - ENHANCED
// ============================================================================
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    service: 'DigiSprout Backend - Chatbot + FCM Notifications 🌿',
    version: '3.3.0-optimized',
    groqConfigured: !!GROQ_API_KEY,
    chatbotAppConfigured: !!chatbotApp,
    fcmAppConfigured: !!fcmApp,
    model: GROQ_MODEL,
    cache: {
      enabled: true,
      size: responseCache.size,
      duration: `${CACHE_DURATION / 1000 / 60} minutes`
    },
    projects: {
      chatbot: 'digibot-qkf9',
      fcm: 'digisproutapp'
    },
    features: {
      chatbot: 'Dialogflow + Groq Hybrid (digibot-qkf9)',
      notifications: 'Firebase Cloud Messaging (digisproutapp)',
      highConfidence: 'Strict KB-only enhancement',
      mediumConfidence: 'Strict KB-only enhancement',
      lowConfidence: 'Hybrid (KB + General Knowledge)',
      noMatch: 'General gardening knowledge',
      caching: 'Response caching enabled',
      keepAlive: 'Auto-ping enabled'
    },
    endpoints: {
      detectIntent: 'POST /detectIntent',
      sendChatNotification: 'POST /send-chat-notification',
      sendBatchNotifications: 'POST /send-batch-notifications',
      testGroq: 'POST /test-groq',
      testHybrid: 'POST /test-hybrid',
      testGeneral: 'POST /test-general',
      ping: 'GET /ping',
      health: 'GET /'
    }
  });
});

// ============================================================================
// TEST ENDPOINTS (All retained)
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

app.post('/test-hybrid', async (req, res) => {
  const { query, kbText } = req.body;

  if (!GROQ_API_KEY) {
    return res.status(400).json({ error: 'GROQ_API_KEY not configured' });
  }

  try {
    const hybrid = await handleLowConfidenceWithGroq(
      query || 'How to deal with aphids?',
      kbText || 'Aphids are small insects.'
    );

    res.json({
      mode: 'hybrid',
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
// ✅ NEW: SELF-PING KEEP-ALIVE (Prevents Render from sleeping)
// ============================================================================
const BACKEND_URL = process.env.BACKEND_URL || 'https://dialogflow-backend-9af5.onrender.com';

function startKeepAlive() {
  // Ping every 14 minutes (before Render's 15-minute timeout)
  setInterval(async () => {
    try {
      await axios.get(`${BACKEND_URL}/ping`, { timeout: 5000 });
      console.log(`[KEEP-ALIVE] Ping sent at ${new Date().toISOString()}`);
    } catch (error) {
      console.error('[KEEP-ALIVE ERROR]:', error.message);
    }
  }, 14 * 60 * 1000); // 14 minutes
}

// ============================================================================
// START SERVER
// ============================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('🌱 DigiSprout Backend Started! 🌱');
  console.log('═══════════════════════════════════════════════════');
  console.log(`📡 Port: ${PORT}`);
  console.log(`🤖 Dialogflow Project: ${projectId}`);
  console.log(`📚 Knowledge Base ID: ${knowledgeBaseId}`);
  console.log(`✨ Groq API: ${GROQ_API_KEY ? '✅ Configured' : '❌ NOT CONFIGURED'}`);
  console.log(`🤖 Chatbot App: ${chatbotApp ? '✅ Configured (digibot-qkf9)' : '❌ NOT CONFIGURED'}`);
  console.log(`🔔 FCM App: ${fcmApp ? '✅ Configured (digisproutapp)' : '❌ NOT CONFIGURED'}`);
  console.log(`🧠 Model: ${GROQ_MODEL}`);
  console.log(`💾 Cache: Enabled (${CACHE_DURATION / 1000 / 60} minutes)`);
  console.log(`🏓 Keep-Alive: Starting...`);
  console.log('');
  console.log('🎯 Features:');
  console.log('   ✅ Chatbot (Dialogflow + Groq Hybrid)');
  console.log('   ✅ Chat Notifications (FCM)');
  console.log('   ✅ Response Caching (30 min)');
  console.log('   ✅ Auto Keep-Alive (14 min interval)');
  console.log('');
  console.log('📍 Endpoints:');
  console.log(`   GET  / (health check)`);
  console.log(   GET  /ping (keep-alive));
console.log(   POST /detectIntent (chatbot));
console.log(   POST /send-chat-notification (FCM));
console.log('📮 POST /send-batch-notifications (batch FCM)');
console.log('═══════════════════════════════════════════════════');
console.log('');
// ✅ Start keep-alive in production
if (process.env.NODE_ENV === 'production') {
startKeepAlive();
console.log('✅ Keep-alive service started!');
}
});
