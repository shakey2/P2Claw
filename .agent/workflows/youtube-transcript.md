# YouTube Transcript API Usage Guide

> **FOR AI AGENTS:** Read this document whenever you are asked to retrieve a youtube video transcript to avoid syntax errors and token waste.

## Prerequisite
Ensure the package is installed via pip:
```bash
pip install youtube-transcript-api
```

## Correct CLI Command Syntax
Due to potential parsing errors with bash/powershell flags, when querying a video ID that starts with a hyphen (e.g., `-hYE5U6FGk8`), you MUST use `--` before the video ID to prevent it from being parsed as an invalid command flag.

**Correct Example to Export JSON:**
```bash
youtube_transcript_api --format json -- -hYE5U6FGk8 > transcript.json
```

## Correct Python Script Syntax
The default namespace structure can cause attribute errors if imported incorrectly. The correct pattern requires extracting the class properly. Additionally, JSON files produced by windows may include a UTF-16 BOM header, so enforce utf-16 parsing if reading CLI output. Alternatively, just bypass the CLI and do everything purely in Python (recommended):

```python
import json
from youtube_transcript_api import YouTubeTranscriptApi

try:
    # Notice the explicit class call
    transcript = YouTubeTranscriptApi.get_transcript('-hYE5U6FGk8')
    
    # Filter by specific timestamp (e.g. 16:20 to 22:08 -> 980s to 1328s)
    filtered = [x['text'] for x in transcript if 975 <= x['start'] <= 1335]
    
    with open('filtered_snippet.txt', 'w', encoding='utf-8') as fw:
        fw.write(' '.join(filtered))
        
except Exception as e:
    print('Error:', e)
```
