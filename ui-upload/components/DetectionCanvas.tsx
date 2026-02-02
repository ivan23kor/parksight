"use client"

import { useEffect, useRef, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface Detection {
  bbox: [number, number, number, number]
  class: string
  confidence: number
}

interface DetectionCanvasProps {
  imageUrl: string
  detections: Detection[]
  imageWidth: number
  imageHeight: number
}

export function DetectionCanvas({
  imageUrl,
  detections,
  imageWidth,
  imageHeight
}: DetectionCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [imageLoaded, setImageLoaded] = useState(false)
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    if (!canvasRef.current || !imageLoaded) return

    const canvas = canvasRef.current
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const image = new Image()
    image.onload = () => {
      // Calculate display size maintaining aspect ratio
      const maxWidth = 800
      const maxHeight = 600
      let width = image.width
      let height = image.height

      if (width > maxWidth) {
        height = (maxWidth / width) * height
        width = maxWidth
      }
      if (height > maxHeight) {
        width = (maxHeight / height) * width
        height = maxHeight
      }

      setDisplaySize({ width, height })

      // Set canvas dimensions
      canvas.width = width
      canvas.height = height

      // Draw image
      ctx.clearRect(0, 0, width, height)
      ctx.drawImage(image, 0, 0, width, height)

      // Scale factors
      const scaleX = width / imageWidth
      const scaleY = height / imageHeight

      // Draw detections
      detections.forEach((detection) => {
        const [x1, y1, x2, y2] = detection.bbox

        // Scale bounding box
        const scaledX1 = x1 * scaleX
        const scaledY1 = y1 * scaleY
        const scaledWidth = (x2 - x1) * scaleX
        const scaledHeight = (y2 - y1) * scaleY

        // Draw bounding box
        ctx.strokeStyle = "#ef4444"
        ctx.lineWidth = 2
        ctx.strokeRect(scaledX1, scaledY1, scaledWidth, scaledHeight)

        // Draw background for text
        ctx.fillStyle = "#ef4444"
        const text = `${detection.class} ${(detection.confidence * 100).toFixed(1)}%`
        const textMetrics = ctx.measureText(text)
        const textHeight = 20

        ctx.fillRect(
          scaledX1,
          scaledY1 - textHeight,
          textMetrics.width + 4,
          textHeight
        )

        // Draw text
        ctx.fillStyle = "white"
        ctx.font = "14px sans-serif"
        ctx.fillText(text, scaledX1 + 2, scaledY1 - 4)
      })
    }
    image.src = imageUrl
  }, [imageUrl, detections, imageWidth, imageHeight, imageLoaded])

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Detection Results</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="relative inline-block">
            <canvas
              ref={canvasRef}
              className="border border-border rounded-lg"
              style={{ display: imageLoaded ? "block" : "none" }}
            />
            {!imageLoaded && (
              <div
                className="border border-border rounded-lg bg-muted flex items-center justify-center"
                style={{ width: displaySize.width || 400, height: displaySize.height || 300 }}
              >
                <img
                  src={imageUrl}
                  alt="Loading..."
                  onLoad={() => setImageLoaded(true)}
                  style={{ display: "none" }}
                />
                <p className="text-muted-foreground">Loading image...</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {detections.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Detected Signs ({detections.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {detections.map((detection, index) => (
                <div
                  key={index}
                  className="flex justify-between items-center p-3 bg-muted rounded-lg"
                >
                  <span className="font-medium">{detection.class}</span>
                  <span className="text-sm text-muted-foreground">
                    {(detection.confidence * 100).toFixed(1)}% confidence
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {detections.length === 0 && imageLoaded && (
        <Card>
          <CardContent className="p-6">
            <p className="text-center text-muted-foreground">
              No traffic signs detected in this image
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}