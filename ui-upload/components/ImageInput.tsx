"use client"

import { useState, useCallback, useRef, useEffect } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent } from "@/components/ui/card"
import { Upload, Link, Clipboard } from "lucide-react"

interface ImageInputProps {
  onImageSelect: (image: string | File) => void
  isProcessing?: boolean
}

export function ImageInput({ onImageSelect, isProcessing = false }: ImageInputProps) {
  const [url, setUrl] = useState("")
  const containerRef = useRef<HTMLDivElement>(null)

  const handleFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file && file.type.startsWith("image/")) {
      onImageSelect(file)
    }
  }, [onImageSelect])

  const handleUrlSubmit = useCallback(() => {
    if (url.trim()) {
      onImageSelect(url.trim())
    }
  }, [url, onImageSelect])

  const handlePaste = useCallback(async () => {
    try {
      const clipboardItems = await navigator.clipboard.read()
      for (const item of clipboardItems) {
        for (const type of item.types) {
          if (type.startsWith("image/")) {
            const blob = await item.getType(type)
            const file = new File([blob], "pasted-image.png", { type: blob.type })
            onImageSelect(file)
            return
          }
        }
      }
    } catch (err) {
      console.error("Failed to read clipboard:", err)
    }
  }, [onImageSelect])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "v" && !isProcessing) {
        const activeTag = (e.target as HTMLElement).tagName
        if (activeTag !== "INPUT" && activeTag !== "TEXTAREA") {
          e.preventDefault()
          handlePaste()
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [handlePaste, isProcessing])

  return (
    <Card className="w-full max-w-2xl mx-auto">
      <CardContent className="p-6">
        <Tabs defaultValue="clipboard" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="file" className="flex items-center gap-2">
              <Upload className="w-4 h-4" />
              Upload
            </TabsTrigger>
            <TabsTrigger value="url" className="flex items-center gap-2">
              <Link className="w-4 h-4" />
              URL
            </TabsTrigger>
            <TabsTrigger value="clipboard" className="flex items-center gap-2">
              <Clipboard className="w-4 h-4" />
              Paste
            </TabsTrigger>
          </TabsList>

          <TabsContent value="file" className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="file-upload">Select an image file</Label>
              <Input
                id="file-upload"
                type="file"
                accept="image/*"
                onChange={handleFileUpload}
                disabled={isProcessing}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              Supports JPG, PNG, WebP formats
            </p>
          </TabsContent>

          <TabsContent value="url" className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="url-input">Image URL</Label>
              <Input
                id="url-input"
                type="url"
                placeholder="https://example.com/image.jpg"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={isProcessing}
              />
            </div>
            <Button onClick={handleUrlSubmit} disabled={!url.trim() || isProcessing}>
              Load from URL
            </Button>
          </TabsContent>

          <TabsContent value="clipboard" className="space-y-4">
            <div className="space-y-2">
              <Label>Paste from clipboard</Label>
              <p className="text-sm text-muted-foreground">
                Press Ctrl+V (Cmd+V on Mac) or click the button below
              </p>
            </div>
            <Button onClick={handlePaste} disabled={isProcessing} variant="outline" className="w-full">
              <Clipboard className="w-4 h-4 mr-2" />
              Paste Image
            </Button>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}