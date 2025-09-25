// AudioWorklet processor for real-time audio processing
// Optimized for Mastra realtime voice with PCM 16-bit output

class AudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Smaller buffer for lower latency
    this.chunkSize = options?.processorOptions?.chunkSize || 1024;
    this.buffer = new Float32Array(this.chunkSize);
    this.bufferIndex = 0;
    this.frameCount = 0;
    this.levelUpdateInterval = 512; // Update level more frequently
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];

    if (input.length > 0) {
      const inputChannel = input[0];
      let rmsSum = 0;

      // Process each sample
      for (let i = 0; i < inputChannel.length; i++) {
        const sample = inputChannel[i];
        this.buffer[this.bufferIndex] = sample;
        rmsSum += sample * sample;
        this.bufferIndex++;

        // When buffer is full, send PCM chunk to main thread
        if (this.bufferIndex >= this.chunkSize) {
          // Convert Float32 to Int16 PCM as required by Mastra
          const int16Buffer = new Int16Array(this.chunkSize);

          for (let j = 0; j < this.chunkSize; j++) {
            // Clamp to [-1, 1] and convert to 16-bit signed integer
            const clampedSample = Math.max(-1, Math.min(1, this.buffer[j]));
            int16Buffer[j] = Math.round(clampedSample * 32767);
          }

          // Calculate RMS level for this chunk
          const rmsLevel = Math.sqrt(rmsSum / this.chunkSize);

          // Send PCM audio data to main thread
          this.port.postMessage({
            type: 'audioData',
            audioData: int16Buffer, // Int16Array PCM data
            audioLevel: rmsLevel,
            timestamp: currentTime,
            sampleRate: sampleRate,
            channels: 1,
            bitDepth: 16,
            chunkSize: this.chunkSize
          });

          // Reset buffer
          this.bufferIndex = 0;
          rmsSum = 0;
        }
      }

      // Send audio level updates more frequently for real-time feedback
      this.frameCount += inputChannel.length;
      if (this.frameCount >= this.levelUpdateInterval) {
        const rmsLevel = Math.sqrt(rmsSum / inputChannel.length);
        this.port.postMessage({
          type: 'audioLevel',
          level: Math.min(1, rmsLevel * 5), // Normalize for UI display
          timestamp: currentTime
        });
        this.frameCount = 0;
      }
    }

    // Keep processor alive
    return true;
  }
}

// Register the processor
registerProcessor('audio-processor', AudioProcessor);