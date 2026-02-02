interface BackendDetection {
  x1: number
  y1: number
  x2: number
  y2: number
  confidence: number
  class_name: string
}

interface BackendDetectionResponse {
  detections: BackendDetection[]
  inference_time_ms: number
  image_width: number
  image_height: number
}

interface Detection {
  bbox: [number, number, number, number]
  class: string
  confidence: number
}

interface DetectionResponse {
  detections: Detection[]
  image_width: number
  image_height: number
  inference_time_ms: number
}

function transformResponse(backend: BackendDetectionResponse): DetectionResponse {
  return {
    detections: backend.detections.map((d) => ({
      bbox: [d.x1, d.y1, d.x2, d.y2],
      class: d.class_name,
      confidence: d.confidence,
    })),
    image_width: backend.image_width,
    image_height: backend.image_height,
    inference_time_ms: backend.inference_time_ms,
  }
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"

export async function detectSignsFromFile(file: File): Promise<DetectionResponse> {
  const formData = new FormData()
  formData.append("file", file)

  const response = await fetch(`${API_BASE_URL}/detect-file?confidence=0.15`, {
    method: "POST",
    body: formData,
  })

  if (!response.ok) {
    throw new Error(`API error: ${response.statusText}`)
  }

  const backend: BackendDetectionResponse = await response.json()
  return transformResponse(backend)
}

export async function detectSignsFromUrl(url: string): Promise<DetectionResponse> {
  const response = await fetch(`${API_BASE_URL}/detect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ image_url: url, confidence: 0.15 }),
  })

  if (!response.ok) {
    throw new Error(`API error: ${response.statusText}`)
  }

  const backend: BackendDetectionResponse = await response.json()
  return transformResponse(backend)
}
