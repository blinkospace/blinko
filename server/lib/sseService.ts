import { Response } from 'express';

interface SSEConnection {
  userId: number;
  response: Response;
  connectedAt: Date;
}

class SSEServiceClass {
  private connections: Map<number, Set<SSEConnection>> = new Map();
  private readonly MAX_CONNECTIONS_PER_USER = 5;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startHeartbeat();
  }

  /**
   * Register a new SSE connection for a user
   */
  connect(userId: number, res: Response): void {
    if (!this.connections.has(userId)) {
      this.connections.set(userId, new Set());
    }

    const userConnections = this.connections.get(userId)!;

    // Enforce max connections
    if (userConnections.size >= this.MAX_CONNECTIONS_PER_USER) {
      console.warn(`User ${userId} exceeded max SSE connections`);
      // Remove oldest connection
      const oldest = Array.from(userConnections)[0];
      this.disconnect(userId, oldest.response);
    }

    const connection: SSEConnection = {
      userId,
      response: res,
      connectedAt: new Date(),
    };

    userConnections.add(connection);
    console.log(`SSE connected: user=${userId}, total=${userConnections.size}`);
  }

  /**
   * Remove a SSE connection
   */
  disconnect(userId: number, res: Response): void {
    const userConnections = this.connections.get(userId);
    if (!userConnections) return;

    const connection = Array.from(userConnections).find(c => c.response === res);
    if (connection) {
      userConnections.delete(connection);
      console.log(`SSE disconnected: user=${userId}, remaining=${userConnections.size}`);

      if (userConnections.size === 0) {
        this.connections.delete(userId);
      }
    }
  }

  /**
   * Broadcast an event to all connections for a user
   */
  broadcast(userId: number, event: string, data: any): void {
    const userConnections = this.connections.get(userId);
    if (!userConnections || userConnections.size === 0) {
      return;
    }

    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const deadConnections: SSEConnection[] = [];

    for (const connection of userConnections) {
      try {
        connection.response.write(payload);
      } catch (error) {
        console.error(`Failed to send SSE to user ${userId}:`, error);
        deadConnections.push(connection);
      }
    }

    // Clean up dead connections
    for (const dead of deadConnections) {
      userConnections.delete(dead);
    }
  }

  /**
   * Broadcast note update event
   */
  broadcastNoteUpdate(userId: number, noteId: number): void {
    this.broadcast(userId, 'note-updated', {
      noteId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Start heartbeat to keep connections alive and detect dead ones
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;

    this.heartbeatInterval = setInterval(() => {
      for (const [userId, connections] of this.connections.entries()) {
        this.broadcast(userId, 'heartbeat', { timestamp: new Date().toISOString() });
      }
    }, 30000); // Every 30 seconds
  }

  /**
   * Stop heartbeat (for cleanup)
   */
  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Get connection stats for monitoring
   */
  getStats(): { totalUsers: number; totalConnections: number } {
    let totalConnections = 0;
    for (const connections of this.connections.values()) {
      totalConnections += connections.size;
    }
    return {
      totalUsers: this.connections.size,
      totalConnections,
    };
  }
}

// Singleton instance
export const SSEService = new SSEServiceClass();
