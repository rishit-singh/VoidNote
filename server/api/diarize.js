const express = require('express');
const Replicate = require('replicate');

const router = express.Router();

const replicate = new Replicate({
    auth: process.env.REPLICATE_API_KEY,
});

router.post('/api/diarize', async (req, res) => {
    try {
        const { file_string, num_speakers, language } = req.body;
        
        const response = await replicate.run("thomasmol/whisper-diarization", {
            input: { 
                file_string,
                num_speakers,
                language 
            }
        });

        res.json(response);
    } catch (error) {
        console.error('Diarization error:', error);
        res.status(500).json({ error: 'Diarization failed' });
    }
});

module.exports = router; 