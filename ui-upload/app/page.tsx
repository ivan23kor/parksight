"use client"

import { useState } from "react"
import { ImageInput } from "@/components/ImageInput"
import { DetectionCanvas } from "@/components/DetectionCanvas"
import { detectSignsFromFile, detectSignsFromUrl } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Loader2 } from "lucide-react"

interface Detection {
  bbox: [number, number, number, number]
  class: string
  confidence: number
}

export default function Home() {
  const [imageUrl, setImageUrl] = useState<string>("")
  const [detections, setDetections] = useState<Detection[]>([])
  const [imageDimensions, setImageDimensions] = useState({ width: 0, height: 0 })
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleImageSelect = async (image: string | File) => {
    setIsProcessing(true)
    setError(null)
    setDetections([])
    setImageDimensions({ width: 0, height: 0 })

    try {
      let result

      if (typeof image === "string") {
        // It's a URL
        setImageUrl(image)
        result = await detectSignsFromUrl(image)
      } else {
        // It's a file
        const url = URL.createObjectURL(image)
        setImageUrl(url)
        result = await detectSignsFromFile(image)
      }

      setDetections(result.detections)
      setImageDimensions({
        width: result.image_width,
        height: result.image_height,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to process image")
      console.error("Detection error:", err)
    } finally {
      setIsProcessing(false)
    }
  }

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-6xl mx-auto space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold tracking-tight">
            Free Parking - Sign Detection
          </h1>
          <p className="text-lg text-muted-foreground">
            Upload an image or provide a URL to detect parking signs
          </p>
        </div>

        {error && (
          <Card className="border-destructive">
            <CardContent className="p-4">
              <p className="text-destructive">{error}</p>
            </CardContent>
          </Card>
        )}

        <ImageInput onImageSelect={handleImageSelect} isProcessing={isProcessing} />

        {isProcessing && (
          <Card>
            <CardContent className="p-8">
              <div className="flex items-center justify-center gap-2">
                <Loader2 className="w-6 h-6 animate-spin" />
                <span>Processing image...</span>
              </div>
            </CardContent>
          </Card>
        )}

        {imageUrl && !isProcessing && (
          <DetectionCanvas
            imageUrl={imageUrl}
            detections={detections}
            imageWidth={imageDimensions.width}
            imageHeight={imageDimensions.height}
          />
        )}
      </div>
    </div>
  )
}