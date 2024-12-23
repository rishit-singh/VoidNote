from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import replicate
import os
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://localhost:5173"],  # Your frontend URL
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class DiarizationRequest(BaseModel):
    file_string: str
    num_speakers: int
    language: str = "en"

@app.post("/api/diarize")
async def diarize(request: DiarizationRequest):
    try:
        # Save file_string to a file
        import datetime
        
        # Get timestamp for unique filename
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"uploads/audio_{timestamp}.txt"
        
        # Create uploads directory if it doesn't exist
        os.makedirs("uploads", exist_ok=True)
        
        # Write file_string to file
        with open(filename, "w") as f:
            f.write(request.file_string)
            
        # Initialize Replicate client
        client = replicate.Client(api_token=os.getenv("REPLICATE_API_KEY"))

        # Run the model
        output = client.run(
            "thomasmol/whisper-diarization:cbd15da9f839c5f932742f86ce7def3a03c22e2b4171d42823e83e314547003f",
            input={
                "file": request.file_string,
                "num_speakers": request.num_speakers,
                "language": request.language
            }
        )
        
        return output

    except Exception as e:
        print(f"Error in diarization: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3000)