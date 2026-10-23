package app.piccove.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.*;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private final ExecutorService actions = Executors.newSingleThreadExecutor();
    private final ExecutorService images = Executors.newFixedThreadPool(2);
    private final ArrayList<JSONObject> photos = new ArrayList<>();
    private final ArrayList<JSONObject> albums = new ArrayList<>();
    private ApiClient api;
    private JSONObject account;
    private LinearLayout root, content, navigation;
    private TextView status;
    private boolean busy, hasMore, detail;
    private int page = 1, generation;
    private String albumId, albumName = "全部照片", tab = "photos";
    private static final int GREEN = Color.rgb(40,108,92), INK = Color.rgb(32,51,44), MUTED = Color.rgb(111,130,120);
    private static final int PICK_IMAGES = 10;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::navigateBack);
        }
        showLogin();
    }
    // API 33+ uses the platform callback registered above; this handles older devices.
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Override public void onBackPressed() { navigateBack(); }
    private void navigateBack() {
        if (busy) return;
        if (account != null && (detail || !tab.equals("photos"))) {
            tab="photos"; showPhotos();
        } else moveTaskToBack(true);
    }
    @Override public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        if (account != null) renderTab();
    }
    @Override public void onDestroy() {
        generation++;
        actions.shutdownNow(); images.shutdownNow();
        if (api != null) api.clear();
        super.onDestroy();
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private LinearLayout column() {
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); return layout;
    }
    private LinearLayout row() {
        LinearLayout layout = new LinearLayout(this); layout.setGravity(Gravity.CENTER_VERTICAL); return layout;
    }
    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color);
        view.setPadding(0, dp(6), 0, dp(6)); return view;
    }
    private TextView heading(String value) {
        TextView view = text(value, 28, INK); view.setTypeface(null, Typeface.BOLD); return view;
    }
    private GradientDrawable background(int color, int radius) {
        GradientDrawable shape = new GradientDrawable(); shape.setColor(color); shape.setCornerRadius(dp(radius)); return shape;
    }
    private Button button(String label, Runnable action) {
        Button button = new Button(this); button.setText(label); button.setTextColor(GREEN); button.setAllCaps(false);
        button.setMinHeight(dp(48)); button.setOnClickListener(v -> { if (!busy) action.run(); }); return button;
    }
    private EditText field(String hint, int type) {
        EditText field = new EditText(this); field.setHint(hint); field.setSingleLine(); field.setInputType(type);
        field.setTextSize(16); field.setPadding(dp(12),dp(14),dp(12),dp(14)); return field;
    }
    private void shell(String title, String subtitle, boolean withNavigation) {
        generation++;
        detail=false;
        root = column(); root.setBackgroundColor(Color.rgb(247,249,246));
        root.setPadding(dp(20),dp(12),dp(20),dp(8));
        setContentView(root);
        root.setOnApplyWindowInsetsListener((v,insets) -> {
            android.graphics.Insets safe;
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                v.setPadding(dp(20)+safe.left,dp(12)+safe.top,dp(20)+safe.right,dp(8)+safe.bottom);
            } else v.setPadding(dp(20),dp(12)+insets.getSystemWindowInsetTop(),dp(20),dp(8)+insets.getSystemWindowInsetBottom());
            return insets;
        });
        root.requestApplyInsets();
        root.addView(text("≈  PicCove · 图湾",16,GREEN));
        root.addView(heading(title));
        root.addView(text(subtitle,13,MUTED));
        status = text("",13,GREEN); status.setVisibility(View.GONE); root.addView(status);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true);
        content = column(); scroll.addView(content);
        root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        if (withNavigation) {
            navigation = row();
            for (String[] item : new String[][]{{"photos","照片"},{"albums","相册"},{"account","我的"}}) {
                Button control = button(item[1], () -> {tab=item[0]; renderTab();});
                if (tab.equals(item[0])) control.setTypeface(null,Typeface.BOLD);
                navigation.addView(control,new LinearLayout.LayoutParams(0,dp(54),1));
            }
            root.addView(navigation);
        }
        if (busy) progress("处理中…");
    }
    private void progress(String message) { status.setText(message); status.setVisibility(View.VISIBLE); }
    private void error(Exception error) {
        if (isDestroyed()) return;
        if (error instanceof ApiClient.ApiException && ((ApiClient.ApiException)error).status==401 && account!=null) {
            api.clear(); account=null; photos.clear(); albums.clear(); showLogin();
            progress("登录已过期，请重新登录");
        } else {
            String message=error.getMessage();
            progress(message==null ? "请求失败，请检查网络后重试" : message);
        }
    }
    interface Work { void run() throws Exception; }
    private void perform(String message, Work work, Runnable success) {
        if (busy) return;
        busy=true; progress(message);
        actions.execute(() -> {
            try {
                work.run();
                runOnUiThread(() -> { if (!isDestroyed()) { busy=false; status.setVisibility(View.GONE); success.run(); } });
            } catch (Exception e) { runOnUiThread(() -> {busy=false;error(e);}); }
        });
    }
    private void showLogin() {
        shell("每一张照片，都有归处", "连接你的图湾，收藏生活中的片刻。", false);
        EditText server=field("服务器 · https://img.example.com",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_URI);
        EditText username=field("用户名",InputType.TYPE_CLASS_TEXT);
        EditText password=field("密码",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);
        EditText code=field("动态验证码（已开启二步验证时必填）",InputType.TYPE_CLASS_NUMBER);
        server.setText(getPreferences(0).getString("server","")); username.setText(getPreferences(0).getString("username",""));
        content.addView(server); content.addView(username); content.addView(password); content.addView(code);
        content.addView(button("连接并登录", () -> {
            final String address=server.getText().toString(), name=username.getText().toString().trim(), secret=password.getText().toString(), otp=code.getText().toString().trim();
            if (name.isEmpty() || secret.isEmpty()) { progress("请填写用户名与密码"); return; }
            perform("正在连接…", () -> {
                ApiClient candidate=new ApiClient(address);
                if (!candidate.json("GET","/settings",null).optBoolean("private_images",false))
                    throw new Exception("服务端尚不支持私有相册，请先升级 PicCove 服务端");
                candidate.json("POST","/auth/login",new JSONObject().put("username",name).put("password",secret).put("code",otp));
                JSONObject me=candidate.json("GET","/me",null);
                api=candidate; account=me;
            }, () -> {
                password.setText(""); code.setText(""); getPreferences(0).edit().putString("server",api.origin).putString("username",name).apply();
                tab="photos"; albumId=null; albumName="全部照片"; page=1; refresh();
            });
        }));
        content.addView(text("新照片默认私有，仅本人和服务器管理员可见。公开分享需要你的确认。",15,MUTED));
        content.addView(text("使用管理员提供的账号，或先在网站注册。密码和登录会话只保存在内存，关闭进程后需重新登录。",13,MUTED));
    }
    private void refresh() {
        perform("正在整理照片…", () -> {
            JSONObject me=api.json("GET","/me",null);
            JSONArray groups=api.albums();
            JSONObject result=api.json("GET","/images?page="+page+(albumId==null?"":"&album_id="+albumId),null);
            ArrayList<JSONObject> loaded=new ArrayList<>(), grouped=new ArrayList<>();
            JSONArray items=result.getJSONArray("items");
            for(int i=0;i<items.length();i++) loaded.add(items.getJSONObject(i));
            for(int i=0;i<groups.length();i++) grouped.add(groups.getJSONObject(i));
            // UI state is installed on the main thread before rendering.
            runOnUiThread(() -> { account=me; photos.clear();photos.addAll(loaded);albums.clear();albums.addAll(grouped);hasMore=result.optBoolean("has_more"); });
        }, this::renderTab);
    }
    private void renderTab() {
        switch (tab) { case "albums": showAlbums();break; case "account":showAccount();break; default:showPhotos(); }
    }
    private void showPhotos() {
        shell(albumName,"把日常的光，留在自己的相册里。",true);
        LinearLayout toolbar=row();
        toolbar.addView(button("＋ 上传照片",this::pickImages),new LinearLayout.LayoutParams(0,dp(52),1));
        toolbar.addView(button("刷新",this::refresh)); content.addView(toolbar);
        if(albumId!=null) content.addView(button("查看全部照片",()->{albumId=null;albumName="全部照片";page=1;refresh();}));
        if(photos.isEmpty()) {
            content.addView(text("相册还很安静",23,INK));
            content.addView(text("选择几张照片，让它们在这里安家。\n新上传的照片不会生成公开外链。",15,MUTED));
        }
        int columns=getResources().getConfiguration().screenWidthDp>=600?3:2;
        for(int i=0;i<photos.size();i+=columns) {
            LinearLayout line=row(); line.setGravity(Gravity.TOP); content.addView(line);
            for(int j=0;j<columns;j++) {
                if(i+j>=photos.size()) {line.addView(new View(this),new LinearLayout.LayoutParams(0,1,1));continue;}
                JSONObject photo=photos.get(i+j);
                LinearLayout card=column(); card.setPadding(dp(4),dp(4),dp(4),dp(10)); card.setBackground(background(Color.WHITE,14));
                LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(0,-2,1);params.setMargins(dp(3),dp(5),dp(3),dp(5));line.addView(card,params);
                ImageView image=new ImageView(this);image.setScaleType(ImageView.ScaleType.CENTER_CROP);image.setBackgroundColor(Color.rgb(227,237,228));
                image.setContentDescription("打开照片 "+photo.optString("original_name"));
                card.addView(image,new LinearLayout.LayoutParams(-1,dp(160)));loadImage(image,photo,384);
                TextView name=text(photo.optString("original_name"),14,INK);name.setSingleLine();name.setEllipsize(android.text.TextUtils.TruncateAt.END);card.addView(name);
                card.addView(text(photo.optBoolean("is_public")?"公开分享中":"私有照片",12,MUTED));
                card.setOnClickListener(v->{if(!busy)showPhoto(photo);});image.setOnClickListener(v->{if(!busy)showPhoto(photo);});
            }
        }
        LinearLayout paging=row();
        Button prev=button("上一页",()->{page--;refresh();});prev.setEnabled(page>1);paging.addView(prev);
        paging.addView(text("第 "+page+" 页",14,MUTED),new LinearLayout.LayoutParams(0,-2,1));
        Button next=button("下一页",()->{page++;refresh();});next.setEnabled(hasMore);paging.addView(next);content.addView(paging);
    }
    private void loadImage(ImageView view, JSONObject photo, int maxDimension) {
        // shortcut: previews download originals; add authenticated thumbnails for larger libraries.
        int screen=generation;
        ApiClient client=api;
        images.execute(()->{
            if(screen!=generation||isDestroyed())return;
            try {
                byte[] bytes=client.image(photo.getString("id"));
                BitmapFactory.Options options=new BitmapFactory.Options();options.inJustDecodeBounds=true;
                BitmapFactory.decodeByteArray(bytes,0,bytes.length,options);
                options.inSampleSize=1;
                while(Math.max(options.outWidth,options.outHeight)/options.inSampleSize>maxDimension) options.inSampleSize*=2;
                options.inJustDecodeBounds=false;
                Bitmap bitmap=BitmapFactory.decodeByteArray(bytes,0,bytes.length,options);
                if(bitmap==null)throw new Exception("无法显示图片");
                runOnUiThread(()->{if(screen==generation&&!isDestroyed()) view.setImageBitmap(bitmap);else bitmap.recycle();});
            }catch(Exception e){runOnUiThread(()->{if(screen==generation&&!isDestroyed()) {view.setContentDescription("加载失败，点击重新打开");progress("部分照片未能加载，请刷新重试");}});}
        });
    }
    private void showPhoto(JSONObject photo) {
        shell(photo.optString("original_name"),photo.optBoolean("is_public")?"公开 · 持有链接即可访问":"私有 · 本人及管理员可见",false);
        detail=true;
        content.addView(button("‹ 返回相册",this::showPhotos));
        ImageView image=new ImageView(this);image.setAdjustViewBounds(true);image.setScaleType(ImageView.ScaleType.FIT_CENTER);
        image.setContentDescription(photo.optString("original_name"));content.addView(image,new LinearLayout.LayoutParams(-1,dp(320)));loadImage(image,photo,2048);
        content.addView(text(photo.optInt("width")+" × "+photo.optInt("height")+"  ·  "+size(photo.optLong("size_bytes")),13,MUTED));
        content.addView(button("修改名称",()->prompt("修改名称",photo.optString("original_name"),name ->
            perform("正在保存…",()->api.json("PATCH","/images/"+photo.getString("id"),new JSONObject().put("original_name",name).put("album_id",photo.opt("album_id"))),this::refresh))));
        content.addView(button("移入相册",()->movePhoto(photo)));
        content.addView(button(photo.optBoolean("is_public")?"分享公开链接":"公开并分享",()->{
            if(photo.optBoolean("is_public")) share(photo);
            else new AlertDialog.Builder(this).setTitle("公开这张照片？").setMessage("任何持有链接的人都能查看。之后可停止分享，但无法撤回已被他人保存的副本。")
                .setNegativeButton("取消",null).setPositiveButton("公开并分享",(d,w)->perform("正在开启分享…",()->api.json("PATCH","/images/"+photo.getString("id")+"/visibility",new JSONObject().put("is_public",true)),()->{
                    try{photo.put("is_public",true);}catch(Exception ignored){}showPhoto(photo);share(photo);
                })).show();
        }));
        if(photo.optBoolean("is_public"))content.addView(button("停止公开分享",()->
            new AlertDialog.Builder(this).setTitle("停止公开分享？").setMessage("原链接将不再允许访客访问，已下载的副本无法撤回。")
                .setNegativeButton("取消",null).setPositiveButton("停止分享",(d,w)->perform("正在停止分享…",()->api.json("PATCH","/images/"+photo.getString("id")+"/visibility",new JSONObject().put("is_public",false)),()->{
                    try{photo.put("is_public",false);}catch(Exception ignored){}showPhoto(photo);
                })).show()));
        content.addView(button("删除照片",()->new AlertDialog.Builder(this).setTitle("永久删除照片？").setMessage("删除云端原图和外链，无法恢复。手机上的原照片不会被删除。")
            .setNegativeButton("保留",null).setPositiveButton("永久删除",(d,w)->perform("正在删除…",()->api.json("DELETE","/images/"+photo.getString("id"),null),this::refresh)).show()));
    }
    private void share(JSONObject photo) {
        Intent intent=new Intent(Intent.ACTION_SEND);intent.setType("text/plain");
        intent.putExtra(Intent.EXTRA_TEXT,api.origin+"/i/"+photo.optString("id"));
        startActivity(Intent.createChooser(intent,"分享照片链接"));
    }
    private void movePhoto(JSONObject photo) {
        String[] names=new String[albums.size()+1];names[0]="不放入相册";
        for(int i=0;i<albums.size();i++)names[i+1]=albums.get(i).optString("name");
        new AlertDialog.Builder(this).setTitle("选择相册").setItems(names,(d,which)->perform("正在移动…",()->api.json("PATCH","/images/"+photo.getString("id"),new JSONObject().put("original_name",photo.getString("original_name")).put("album_id",which==0?JSONObject.NULL:albums.get(which-1).getString("id"))),this::refresh)).show();
    }
    interface TextAction { void run(String value); }
    private void prompt(String title,String value,TextAction action) {
        EditText input=field(title,InputType.TYPE_CLASS_TEXT);input.setText(value);
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle(title).setView(input).setNegativeButton("取消",null).setPositiveButton("保存",null).create();
        dialog.setOnShowListener(d->dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->{
            String name=input.getText().toString().trim();if(name.isEmpty()){input.setError("请填写名称");return;}dialog.dismiss();action.run(name);
        }));dialog.show();
    }
    private void showAlbums() {
        shell("我的相册","按生活的章节，整理每一份记忆。",true);
        content.addView(button("＋ 新建相册",()->prompt("相册名称","",name->perform("正在创建…",()->api.json("POST","/albums",new JSONObject().put("name",name)),this::refresh))));
        if(albums.isEmpty())content.addView(text("还没有相册，创建一个开始整理吧。",16,MUTED));
        for(JSONObject album:albums) {
            LinearLayout line=row();
            line.addView(button("▧  "+album.optString("name"),()->{albumId=album.optString("id");albumName=album.optString("name");page=1;tab="photos";refresh();}),new LinearLayout.LayoutParams(0,dp(64),1));
            line.addView(button("删除",()->new AlertDialog.Builder(this).setTitle("删除相册？").setMessage("仅删除分类，照片会保留在全部照片中。")
                .setNegativeButton("取消",null).setPositiveButton("删除相册",(d,w)->perform("正在删除相册…",()->api.json("DELETE","/albums/"+album.getString("id"),null),()->{if(album.optString("id").equals(albumId)){albumId=null;albumName="全部照片";page=1;}refresh();})).show()));content.addView(line);
        }
    }
    private void showAccount() {
        shell("我的图湾","照片属于你，分享由你决定。",true);
        JSONObject user=account.optJSONObject("user");
        content.addView(heading(user==null?"":user.optString("username")));
        content.addView(text(api.origin,14,MUTED));
        content.addView(text("已用 "+size(account.optLong("used_bytes"))+" / "+size(user==null?0:user.optLong("quota_bytes")),18,INK));
        content.addView(text("私有照片仅本人和服务器管理员可见，不是端到端加密。Web 上传和历史图片仍可能是公开的，请留意每张照片的状态。",15,MUTED));
        content.addView(text("当前版本为手动上传，不会后台扫描或自动备份手机照片。关闭进程后需重新登录。",14,MUTED));
        content.addView(button("退出登录",()->perform("正在退出…",()->api.json("POST","/auth/logout",null),()->{api.clear();account=null;photos.clear();albums.clear();showLogin();})));
        content.addView(button("仅清除此设备登录",()->new AlertDialog.Builder(this).setTitle("清除本机登录？").setMessage("用于离线退出。服务器会话仍会保留到过期；联网时优先使用退出登录。")
            .setNegativeButton("取消",null).setPositiveButton("清除",(d,w)->{api.clear();account=null;photos.clear();albums.clear();showLogin();}).show()));
    }
    private String size(long bytes) { return bytes>=1073741824?String.format(java.util.Locale.ROOT,"%.2f GiB",bytes/1073741824.0):String.format(java.util.Locale.ROOT,"%.1f MiB",bytes/1048576.0); }
    private void pickImages() {
        Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT);intent.setType("image/*");intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true);
        intent.putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"image/jpeg","image/png","image/webp","image/gif"});
        startActivityForResult(intent,PICK_IMAGES);
    }
    @Override protected void onActivityResult(int request,int result,Intent data) {
        super.onActivityResult(request,result,data);
        if(request!=PICK_IMAGES||result!=RESULT_OK||data==null)return;
        ArrayList<Uri> selected=new ArrayList<>();
        if(data.getClipData()!=null)for(int i=0;i<data.getClipData().getItemCount();i++)selected.add(data.getClipData().getItemAt(i).getUri());
        else if(data.getData()!=null)selected.add(data.getData());
        if(selected.isEmpty())return;
        final String destination=albumId;
        final ArrayList<String> failures=new ArrayList<>();final ArrayList<String> reused=new ArrayList<>();final int[] saved={0};
        perform("正在上传 0 / "+selected.size(),()->{
            for(int i=0;i<selected.size();i++) {
                if(Thread.currentThread().isInterrupted())break;
                Uri uri=selected.get(i);String name="photo";
                try {
                    if(!"content".equals(uri.getScheme()))throw new Exception("只支持系统选择器提供的图片");
                    try(Cursor cursor=getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)) {
                        if(cursor!=null&&cursor.moveToFirst())name=cursor.getString(0);
                    }
                    byte[] bytes;
                    try(InputStream stream=getContentResolver().openInputStream(uri)) {
                        if(stream==null)throw new Exception("无法读取照片");bytes=ApiClient.readLimited(stream,ApiClient.MAX_IMAGE);
                    }
                    JSONObject photo=api.upload(name==null?"photo":name,bytes);saved[0]++;
                    if(photo.optBoolean("duplicate")) {
                        reused.add(name+"：已复用“"+photo.getString("original_name")+"”，保留原相册；"+(photo.getBoolean("is_public")?"原图片仍公开，持有链接即可访问。":"原图片仍为私有。"));
                    } else if(destination!=null)try {
                        api.json("PATCH","/images/"+photo.getString("id"),new JSONObject().put("original_name",photo.getString("original_name")).put("album_id",destination));
                    } catch(Exception e) {failures.add(name+"：已上传到全部照片，移入相册失败");}
                }catch(Exception e){failures.add(name+"："+e.getMessage());}
                final int done=i+1;runOnUiThread(()->{if(!isDestroyed())progress("正在上传 "+done+" / "+selected.size());});
            }
        },()->{
            new AlertDialog.Builder(this).setTitle("已上传 "+saved[0]+" / "+selected.size()+" 张")
                .setMessage((saved[0]>reused.size()?"新上传的照片已私有保存。\n":"")+String.join("\n",reused)+(reused.isEmpty()||failures.isEmpty()?"":"\n")+String.join("\n",failures))
                .setPositiveButton("完成",(d,w)->{page=1;refresh();}).setCancelable(false).show();
        });
    }
}
