# yt2pt

Download YouTube videos with metadata and thumbnails, organized for PeerTube migration.

## Prerequisites

- **Node.js** (v18+)
- **yt-dlp** binary in the `bin/` directory

## Setup

```bash
npm install
npm run build
```

## Usage

```bash
# Show help
node dist/index.js -h

# Show version
node dist/index.js -v

# Download a video
node dist/index.js https://www.youtube.com/watch?v=xTGk_7radyc
```

## What it does

Given a YouTube URL, yt2pt will:

1. **Download the video** in best available quality (audio + video muxed into MKV)
2. **Download the thumbnail** in best available quality (converted to JPG)
3. **Create a `metadata.json`** with essential video information

## Folder structure

All downloads are stored under a `downloads/` directory:

```
downloads/
└── {CHANNEL_NAME}/
    └── {PUBLISHED_DATE}_{VIDEO_TITLE}_{[VIDEO_ID]}/
        ├── metadata.json
        ├── thumbnail.jpg
        └── {VIDEO_TITLE}_{[VIDEO_ID]}.mkv
```

### Example

```
downloads/
└── Fireship/
    └── 2024-01-15_God-Tier_Developer_Roadmap_[xTGk_7radyc]/
        ├── metadata.json
        ├── thumbnail.jpg
        └── God-Tier_Developer_Roadmap_[xTGk_7radyc].mkv
```

## metadata.json

```json
{
  "channel": "Fireship",
  "channel_id": "UCsBjURrPoezykLs9EqgamOA",
  "channel_url": "https://www.youtube.com/channel/UCsBjURrPoezykLs9EqgamOA",
  "id": "xTGk_7radyc",
  "title": "God-Tier Developer Roadmap",
  "fulltitle": "God-Tier Developer Roadmap",
  "ext": "mkv",
  "alt_title": null,
  "description": "...",
  "upload_date": "20240115",
  "thumbnail": "thumbnail.jpg"
}
```

| Field | Description |
|-------|-------------|
| `channel` | Full name of the YouTube channel |
| `channel_id` | Channel identifier |
| `channel_url` | URL of the channel |
| `id` | YouTube video ID |
| `title` | Video title |
| `fulltitle` | Full video title |
| `ext` | Video file extension |
| `alt_title` | Secondary title (if any) |
| `description` | Video description |
| `upload_date` | Upload date in UTC (YYYYMMDD) |
| `thumbnail` | Filename of the thumbnail in the same folder |
