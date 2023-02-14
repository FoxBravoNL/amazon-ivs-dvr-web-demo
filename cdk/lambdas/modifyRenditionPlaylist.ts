import { CloudFrontRequestEvent } from "aws-lambda";
import { StreamState } from "@aws-sdk/client-ivs";

import { createResponse, getActiveStream, getS3Object } from "./utils";

const WRITE_LATENCY_BUFFER = 2000; // 2 seconds
const PLAYLIST_UPDATE_DELAY = 30000; // 30 seconds
const TOTAL_PLAYLIST_UPDATE_DELAY =
	PLAYLIST_UPDATE_DELAY + WRITE_LATENCY_BUFFER; // 32 seconds

/**
 * Triggered on Origin Requests to process the playlist rendition file from an S3 bucket
 * before returning it to the viewer with the appropriate cache-control headers set.
 *
 * The process for modifying the playlist rendition file is as follows:
 *
 * 1 - The playlist file is fetched from the S3 bucket directly
 *
 * 2 (a) - If the playlist file has been updated within the last 30 seconds (+ 2s write latency buffer),
 *         then the "#EXT-X-ENDLIST" tag is removed from the playlist and the modified file is returned
 *         with max-age set to the remaining time until the next playlist update.
 *
 * 2 (b) - If the playlist file has NOT been updated within the last 30 seconds (+ 2s write latency buffer),
 *         then the channel is checked to see if there is currently an active (live) stream playing
 *
 * 3 (a) - If there is an active stream, then there may be a delay in the playlist update, so the
 *         "#EXT-X-ENDLIST" tag is removed from the playlist and the modified playlist is returned
 *         with max-age=0
 *
 * 3 (b) - If there is NO active stream, then the fetched playlist is final and no modifications are
 *         made to the playlist before returning it with max-age=31536000 (1 year - the maximum TTL
 *         as specified by the cache policy for this caching behavior)
 *
 * @param event CloudFront Origin Request event
 */
const modifyRenditionPlaylist = async (event: CloudFrontRequestEvent) => {
	const { origin, uri } = event.Records[0].cf.request;
	const customHeaders = origin!.s3!.customHeaders;
	const path = origin!.s3!.path;
	const overviewChannelArn =
		customHeaders["overview-channel-arn"][0].value || "";
	const screensChannelArn =
		customHeaders["screens-channel-arn"][0].value || "";
	const captChannelArn = customHeaders["capt-channel-arn"][0].value || "";
	const foChannelArn = customHeaders["fo-channel-arn"][0].value || "";

	const bucketName = customHeaders["vod-record-bucket-name"][0].value || "";
	const key = uri.slice(1);
	let response;

	// Check for which channel the playlist is requested to assign the right arn
	// Example ARN: arn:aws:ivs:us-east-1:667901935354:channel/44USK7rjNnSh
	// Example path: s3://dvrdemostack-vodrecordbucket7dc8b4c7-1btsazxj4r69p/ivs/v1/667901935354/44USK7rjNnSh/2023/2/13/16/19/ayj1JvYhySGJ/events/recording-started.json
	const splitPath = path.split("/"); // Split path up into segments
	const overviewChannelId = overviewChannelArn.split("/")[1]; // Split channelArn into segments from headers for overview
	const screensChannelId = screensChannelArn.split("/")[1]; // Split channelArn into segments from headers for screens
	const captChannelId = captChannelArn.split("/")[1]; // Split channelArn into segments from headers for screens
	const foChannelId = foChannelArn.split("/")[1]; // Split channelArn into segments from headers for screens

	var channelArn = "";

	if (splitPath.includes(overviewChannelId)) {
		// Channel is overview
		channelArn = overviewChannelArn;
		console.log("Modifiy rendition requested for overview");
	} else if (splitPath.includes(screensChannelId)) {
		// Channel is screens
		channelArn = screensChannelArn;
		console.log("Modifiy rendition requested for screens");
	} else if (splitPath.includes(captChannelId)) {
		// Channel is capt
		channelArn = captChannelArn;
		console.log("Modifiy rendition requested for capt");
	} else if (splitPath.includes(foChannelId)) {
		// Channel is FO
		channelArn = foChannelArn;
		console.log("Modifiy rendition requested for fo");
	}

	const removeEndlist = (playlist: string) =>
		playlist.replace("#EXT-X-ENDLIST", "").trim();

	try {
		const { body: playlist, LastModified } = await getS3Object(
			key,
			bucketName
		);
		const LastModifiedTime = LastModified?.getTime() || 0;
		const timeSinceLastModified = Date.now() - LastModifiedTime;
		let body, maxAge;

		if (timeSinceLastModified < TOTAL_PLAYLIST_UPDATE_DELAY) {
			// Playlist updated within the last 32 seconds
			const timeUntilNextUpdate = Math.max(
				0,
				PLAYLIST_UPDATE_DELAY - timeSinceLastModified
			);
			maxAge = Math.floor(timeUntilNextUpdate / 1000); // 0s < maxAge < 30s
			body = removeEndlist(playlist);
		} else {
			// Playlist updated more than 32 seconds ago
			const { state: channelState } =
				(await getActiveStream(channelArn)) || {};
			const isChannelLive = channelState === StreamState.StreamLive;

			if (isChannelLive) {
				// Playlist update could be delayed
				maxAge = 0;
				body = removeEndlist(playlist);
			} else {
				// Playlist is final - no re-write
				maxAge = 31536000; // 31536000 seconds = 1 year (Maximum CF TTL)
				body = playlist;
			}
		}

		response = createResponse(200, { body, maxAge });
	} catch (error) {
		console.error(error);
		response = createResponse(500, { maxAge: 0 });
	}

	return response;
};

export const handler = modifyRenditionPlaylist;
