const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const dialogflow = require('@google-cloud/dialogflow').v2beta1;

const app = express();
app.use(bodyParser.json());
app.use(cors()); // allow all origins, you can restrict later

// Instantiate Dialogflow client
const sessionClient = new dialogflow.SessionsClient({
  keyFilename: 'service-account.json', // <-- points to your service account JSON
});

const projectId = 'digibot-qkf9';
const knowledgeBaseId = 'Njc5Njg3MDI3MDg3NjM4NTI5';

app.post('/detectIntent', async (req, res) => {
  try {
    const { sessionId, query, languageCode } = req.body;

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

    res.json({
      queryText: result.queryText,
      detectedIntent: result.intent?.displayName || null,
      confidence: result.intentDetectionConfidence || 0,
      fulfillmentText: result.fulfillmentText,
      knowledgeAnswers: knowledgeAnswers.map(a => ({
        answer: a.answer,
        matchConfidence: a.matchConfidence,
        matchConfidenceLevel: a.matchConfidenceLevel,
      })),
    });
  } catch (err) {
    console.error('KB SEARCH ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Dialogflow backend running on port ${PORT}`);
});
