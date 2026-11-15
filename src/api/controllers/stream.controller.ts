import { Controller, Get, Inject, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { LiveStreams } from "../live-streams.js";

@Controller("api")
export class StreamController {
  constructor(@Inject(LiveStreams) private readonly streams: LiveStreams) {}

  @Get("stream")
  stream(@Req() request: Request, @Res() response: Response): void {
    this.streams.openFeed(request, response);
  }
}
